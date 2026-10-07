import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { parseDbDate } from './srs';
import {
  AssimilGenerationError,
  type AssimilGenerationProvider,
  generateAssimilArtifact,
  translateLinesToFrench,
} from './assimilGeneration';
import {
  GeminiAudioError,
  analyzeAssimilDialogueAudio,
  transcribeWithGeminiAudio,
} from './assimilGemini';
import { DeepgramTranscriptionError, transcribeWithDeepgram } from './assimilDeepgram';
import { OpenAITranscriptionError, transcribeWithOpenAI } from './assimilOpenAI';
import {
  RunPodTranscriptionError,
  getRunPodTranscriptionStatus,
  normalizeRunPodApiKey,
  runRunPodHealthCheck,
  submitRunPodTranscriptionJob,
  transcribeWithRunPod,
} from './assimilRunpod';
import {
  applyDialogueAnalysis,
  buildAssimilDialogue,
  cleanAssimilTranscript,
  formatAssimilDialogue,
  preserveAssimilTranscript,
  type DialogueLine,
} from './assimilTranscript';
import {
  LESSON_PREFIX,
  type AssimilLevel,
  type AssimilLessonArtifact,
  TOTAL_LESSONS,
  formatLesson,
  parseLessonIndex,
  parseLimit,
  rowToLesson,
  safeJsonParse,
} from './assimilModel';
import {
  getAssimilLessonRow,
  hasGeneratedArtifact,
  listAssimilGeneratedArtifactsByProviderPrefix,
  resetAssimilGeneratedArtifactsByProviderPrefix,
  upsertAssimilLesson,
  withGenerationStatus,
} from './assimilStore';

type ArtifactResult =
  | {
      ok: true;
      artifact: Awaited<ReturnType<typeof generateAssimilArtifact>>;
      generatedBy: string;
      model?: string;
      provider: AssimilGenerationProvider;
    }
  | { ok: false; response: Response };

const DEFAULT_PEDAGOGY_PROVIDER: AssimilGenerationProvider = 'gemini';

async function withAvailability(env: Env, lessons: ReturnType<typeof formatLesson>[]) {
  return Promise.all(
    lessons.map(async (lesson) => ({
      ...lesson,
      available: Boolean(await env.AUDIO.head(lesson.key)),
    })),
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function generateArtifactResponse(
  env: Env,
  index: number,
  level: AssimilLevel,
  transcript: string,
  provider: AssimilGenerationProvider = DEFAULT_PEDAGOGY_PROVIDER,
  model?: string,
): Promise<ArtifactResult> {
  try {
    const artifact = await generateAssimilArtifact(env, index, level, transcript, { model, provider });
    return { ok: true, artifact, generatedBy: generatedBy(provider, model), model, provider };
  } catch (error) {
    const message = error instanceof AssimilGenerationError
      ? error.message
      : 'Génération LLM impossible';
    return { ok: false, response: err(message, 502) };
  }
}

function generatedBy(provider: AssimilGenerationProvider, model?: string): string {
  if (provider === 'gemini') return model ?? 'gemini-3.5-flash';
  return 'deepseek-v4-flash';
}

export async function handleAssimilLessons(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const level = url.searchParams.get('level');
  const checkAvailability = url.searchParams.get('check') === '1';
  const limit = parseLimit(url.searchParams.get('limit'));

  let lessons = Array.from({ length: TOTAL_LESSONS }, (_, index) => formatLesson(index));

  if (level && level !== 'all') {
    lessons = lessons.filter((lesson) => lesson.level === level);
  }

  lessons = lessons.slice(0, limit);

  const availableLessons = checkAvailability ? await withAvailability(env, lessons) : lessons;
  const enrichedLessons = await withGenerationStatus(env, availableLessons);

  return json({
    items: enrichedLessons,
    total: enrichedLessons.length,
    catalog: {
      source: 'assimil_audio',
      prefix: LESSON_PREFIX,
      firstIndex: 0,
      lastIndex: TOTAL_LESSONS - 1,
      targetLevel: 'B2',
      ranges: [
        { level: 'A1', from: 0, to: 20, label: 'Fondations' },
        { level: 'A2', from: 21, to: 45, label: 'Automatismes' },
        { level: 'B1', from: 46, to: 70, label: 'Autonomie' },
        { level: 'B2', from: 71, to: 100, label: 'Fluidité' },
      ],
    },
  });
}

export async function handleGetAssimilLesson(_req: Request, env: Env, rawIndex: string): Promise<Response> {
  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const row = await getAssimilLessonRow(env, index);
  return json({ lesson: rowToLesson(row, index) });
}

interface RecycleAssimilRequest {
  limit?: number;
  profileId: string;
  terms?: string[];
}

function slugForId(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || crypto.randomUUID();
}

function normalizeRecycleTerm(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function findExampleForTarget(
  artifact: AssimilLessonArtifact,
  term: string,
): { en: string; fr: string } {
  const normalizedTerm = term.toLowerCase();
  const sentences = artifact.sentences ?? [];
  const exact = sentences.find((sentence) => sentence.textEn.toLowerCase().includes(normalizedTerm));
  const fallback = sentences[0];
  return {
    en: exact?.textEn ?? fallback?.textEn ?? term,
    fr: exact?.textFr ?? fallback?.textFr ?? '',
  };
}

export async function handleRecycleAssimilLesson(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<RecycleAssimilRequest>().catch(() => null);
  if (!body?.profileId) return err('profileId requis', 400);

  const row = await getAssimilLessonRow(env, index);
  if (!row?.lesson_json || row.lesson_json === '{}') return err('Leçon non générée', 409);

  const artifact = safeJsonParse<AssimilLessonArtifact | null>(row.lesson_json, null);
  if (!artifact?.recyclingTargets?.length) return json({ ok: true, promoted: 0, created: 0, skipped: 0 });

  const base = formatLesson(index);
  // Politique de recyclage : 2 à 3 nouvelles unités par leçon maximum. Le
  // recyclage manuel peut monter plus haut, mais reste explicitement demandé.
  const limit = Math.min(Math.max(Number(body.limit ?? 3), 1), 12);

  // Sélection explicite côté mobile (l'utilisateur peut désélectionner des
  // cibles) : les terms fournis priment sur la limite.
  const requestedTerms = Array.isArray(body.terms)
    ? body.terms.map((term) => normalizeRecycleTerm(term)).filter(Boolean)
    : null;

  const targets = requestedTerms?.length
    ? artifact.recyclingTargets.filter((target) => requestedTerms.includes(normalizeRecycleTerm(target.term ?? '')))
    : artifact.recyclingTargets.slice(0, limit);

  const seen = new Set<string>();
  let promoted = 0;
  let created = 0;
  let skipped = 0;

  for (const target of targets) {
    const term = normalizeRecycleTerm(target.term ?? '');
    const key = term.toLowerCase();
    if (!term || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);

    const example = findExampleForTarget(artifact, term);
    const existing = await env.DB.prepare(
      'SELECT id FROM words WHERE LOWER(mot) = LOWER(?) LIMIT 1',
    ).bind(term).first<{ id: string }>();

    let wordId = existing?.id;
    if (!wordId) {
      wordId = `assim_${base.code.toLowerCase()}_${slugForId(term)}`;
      await env.DB.prepare(`
        INSERT OR IGNORE INTO words (id, mot, type, niveau, traduction, examples, audio_uk, audio_us, frequence)
        VALUES (?, ?, ?, ?, ?, ?, '', '', 4)
      `).bind(
        wordId,
        term,
        target.skill === 'grammar' ? 'phrase' : 'noun',
        base.level,
        target.reasonFr || term,
        JSON.stringify([{ en: example.en, fr: example.fr || target.reasonFr || term }]),
      ).run();
      created += 1;
    }

    const progressId = `${body.profileId}_${wordId}`;
    const existingProgress = await env.DB.prepare(
      'SELECT prochaine_revision, review_history FROM word_progress WHERE id = ?',
    ).bind(progressId).first<{ prochaine_revision: string; review_history: string }>();

    const recycleEntry = {
      date: new Date().toISOString(),
      result: 'assim_recycled',
      aiFeedback: `Recyclé depuis ${base.code}: ${artifact.titleEn || artifact.titleFr || base.title}`,
    };

    if (existingProgress) {
      // Une unité déjà programmée n'est pas remise à due-now : due demain au
      // plus tôt, jamais reculée. L'historique existant est complété, pas écrasé.
      let history: unknown[] = [];
      try { history = JSON.parse(existingProgress.review_history || '[]'); } catch { /* keep empty */ }
      const nextHistory = [...(Array.isArray(history) ? history : []), recycleEntry].slice(-20);

      const candidateMs = Date.now() + 1 * 86400000;
      const existingMs = parseDbDate(existingProgress.prochaine_revision);
      const prochaine = existingMs !== null && existingMs < candidateMs
        ? existingProgress.prochaine_revision
        : new Date(candidateMs).toISOString();

      await env.DB.prepare(`
        UPDATE word_progress SET
          prochaine_revision = ?,
          seen_count = seen_count + 1,
          status = 'learning',
          review_history = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(prochaine, JSON.stringify(nextHistory), progressId).run();
      promoted += 1;
      continue;
    }

    await env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, datetime('now'), 0, 2.5, 1, datetime('now'), 1, 0, 0, 0, 1, 'learning', ?, datetime('now'))
    `).bind(
      progressId,
      body.profileId,
      wordId,
      JSON.stringify([recycleEntry]),
    ).run();
    promoted += 1;
  }

  // Trace le recyclage dans le journal commun : il alimente la progression
  // personnelle de la leçon (étape « Garder »).
  if (promoted > 0) {
    await env.DB.prepare(`
      INSERT INTO learning_events (
        id, profile_id, module, event_type, skill, content_id, payload, occurred_at
      ) VALUES (?, ?, 'listen', 'expression_reinforced', 'vocabulary', ?, ?, ?)
    `).bind(
      `${body.profileId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      body.profileId,
      base.id,
      JSON.stringify({ source: 'assimil_recycle', lessonIndex: index, lessonCode: base.code, promoted }),
      new Date().toISOString(),
    ).run();
  }

  return json({ ok: true, promoted, created, skipped });
}

// ─── GET /assimil/progress?profileId= ────────────────────────────────────────
// Progression personnelle par leçon, dérivée de learning_events (aucune table
// dédiée) : écoute brute → lecture guidée → exercices → expressions gardées.

interface LessonProgress {
  index: number;
  listened: boolean;
  guided: boolean;
  exercises: number;
  kept: number;
  lastAt: string | null;
}

export async function handleAssimilProgress(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';

  const result = await env.DB.prepare(`
    SELECT event_type, payload, occurred_at
    FROM learning_events
    WHERE profile_id = ? AND module = 'listen'
    ORDER BY occurred_at DESC
    LIMIT 3000
  `).bind(profileId).all<{ event_type: string; payload: string; occurred_at: string }>();

  const byLesson = new Map<number, LessonProgress & { exerciseIds: Set<string> }>();

  for (const row of result.results) {
    const payload = safeJsonParse<Record<string, unknown>>(row.payload, {});
    const index = Number(payload.lessonIndex);
    if (!Number.isInteger(index) || index < 0 || index >= TOTAL_LESSONS) continue;

    let entry = byLesson.get(index);
    if (!entry) {
      entry = { index, listened: false, guided: false, exercises: 0, kept: 0, lastAt: row.occurred_at, exerciseIds: new Set() };
      byLesson.set(index, entry);
    }

    const source = typeof payload.source === 'string' ? payload.source : '';
    if (source === 'assimil_audio') entry.listened = true;
    if (source === 'assimil_guided_listen') {
      entry.listened = true;
      entry.guided = true;
    }
    if (source === 'assimil_recycle') entry.kept += Number(payload.promoted) || 0;
    if (row.event_type === 'review_word' && typeof payload.exerciseId === 'string') {
      // Une même série refaite ne compte qu'une fois.
      if (!entry.exerciseIds.has(payload.exerciseId)) {
        entry.exerciseIds.add(payload.exerciseId);
        entry.exercises += 1;
        entry.kept += Array.isArray(payload.promotedWordIds) ? payload.promotedWordIds.length : 0;
      }
    }
  }

  const lessons = [...byLesson.values()]
    .map(({ exerciseIds: _exerciseIds, ...lesson }) => lesson)
    .sort((a, b) => a.index - b.index);

  return json({ lessons });
}

export async function handleAssimilRunPodStatus(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const rawApiKey = env.RUNPOD_API_KEY ?? '';
  const normalizedApiKey = normalizeRunPodApiKey(rawApiKey);
  const endpointId = env.RUNPOD_AI_ENDPOINT_ID?.trim() ?? '';

  return json({
    ok: true,
    hasApiKey: Boolean(rawApiKey),
    rawApiKeyLength: rawApiKey.length,
    normalizedApiKeyLength: normalizedApiKey.length,
    hasEndpointId: Boolean(endpointId),
    endpointId,
  });
}

export async function handleAssimilRunPodHealth(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  try {
    const result = await runRunPodHealthCheck(env);
    return json({ ok: true, runpod: result });
  } catch (error) {
    const message = error instanceof RunPodTranscriptionError
      ? error.message
      : 'RunPod health impossible';
    return err(message, 502);
  }
}

export async function handleUpsertAssimilTranscript(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<{
    transcript?: string;
    transcriptSource?: string;
    titleEn?: string;
    titleFr?: string;
  }>().catch(() => null);

  const transcript = body?.transcript?.trim();
  if (!transcript || transcript.length < 20) return err('transcript requis', 400);
  const preservedTranscript = preserveAssimilTranscript(transcript);

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    titleEn: body?.titleEn ?? null,
    titleFr: body?.titleFr ?? null,
    transcript: preservedTranscript,
    transcriptSource: body?.transcriptSource ?? 'manual',
  });

  const row = await getAssimilLessonRow(env, index);
  return json({ ok: true, lesson: rowToLesson(row, index) });
}

export async function handleTranscribeAssimilLesson(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<{
    provider?: 'auto' | 'deepgram' | 'gemini' | 'openai' | 'runpod';
    model?: string;
    force?: boolean;
    generate?: boolean;
    async?: boolean;
  }>().catch(() => null);
  const existing = await getAssimilLessonRow(env, index);
  if (!body?.force && existing?.transcript?.trim()) {
    if (body?.generate && !hasGeneratedArtifact(existing)) {
      const base = formatLesson(index);
      const artifactResult = await generateArtifactResponse(env, index, base.level, existing.transcript.trim());
      if (!artifactResult.ok) return artifactResult.response;
      const { artifact } = artifactResult;

      await upsertAssimilLesson(env, index, {
        status: 'generated',
        titleEn: artifact.titleEn,
        titleFr: artifact.titleFr,
        transcript: existing.transcript,
        transcriptSource: existing.transcript_source,
        artifact,
        generatedBy: artifactResult.generatedBy,
      });

      const row = await getAssimilLessonRow(env, index);
      return json({ ok: true, cached: false, lesson: rowToLesson(row, index) });
    }

    return json({ ok: true, cached: true, lesson: rowToLesson(existing, index) });
  }

  const base = formatLesson(index);
  const audioObject = await env.AUDIO.get(base.key);
  if (!audioObject) return err(`Audio Assimil introuvable: ${base.key}`, 404);

  const audioBuffer = await audioObject.arrayBuffer();
  const provider = body?.provider ?? 'auto';
  let resolvedProvider: 'deepgram' | 'gemini' | 'openai' | 'runpod' =
    provider === 'auto' ? 'deepgram' : provider;
  let transcription;
  let audioAnalysis: Record<string, unknown> | undefined;
  try {
    const initialPrompt = `English lesson ${base.code}. Short clear phrases for French learners.`;
    if (provider === 'runpod') {
      if (body?.async) {
        const job = await submitRunPodTranscriptionJob(env, {
          audioBase64: arrayBufferToBase64(audioBuffer),
          model: body?.model,
          initialPrompt,
        });

        await upsertAssimilLesson(env, index, {
          status: 'transcribing',
          transcriptionJobId: job.id,
          transcriptionStatus: job.status,
        });

        const row = await getAssimilLessonRow(env, index);
        return json({
          ok: true,
          queued: true,
          job,
          lesson: rowToLesson(row, index),
        }, 202);
      }

      transcription = await transcribeWithRunPod(env, {
        audioBase64: arrayBufferToBase64(audioBuffer),
        model: body?.model,
        initialPrompt,
      });
    } else if (provider === 'deepgram' || provider === 'auto') {
      // Piste principale : ASR dédié, fidèle + diarisation native dans le même appel.
      try {
        resolvedProvider = 'deepgram';
        transcription = await transcribeWithDeepgram(env, {
          audio: audioBuffer,
          model: body?.model,
          minSpeakers: 2,
          maxSpeakers: 2,
        });
      } catch (error) {
        if (provider === 'deepgram') throw error;
        // auto : repli Gemini (diarisation prompt) puis OpenAI (texte fidèle sans locuteurs).
        try {
          resolvedProvider = 'gemini';
          const result = await transcribeWithGeminiAudio(env, {
            audio: audioBuffer,
            filename: `${base.code}-LESSON.mp3`,
            mimeType: 'audio/mpeg',
            lessonCode: base.code,
            model: body?.model,
          });
          transcription = result.transcription;
          audioAnalysis = {
            provider: 'gemini',
            model: transcription.model,
            titleEn: result.analysis.titleEn,
            titleFr: result.analysis.titleFr,
            summaryFr: result.analysis.summaryFr,
            transcriptFr: result.analysis.transcriptFr,
            speakers: result.analysis.speakers ?? [],
            segments: result.analysis.segments ?? [],
            pedagogicalNotes: result.analysis.pedagogicalNotes ?? [],
          };
        } catch (geminiError) {
          resolvedProvider = 'openai';
          transcription = await transcribeWithOpenAI(env, {
            audio: audioBuffer,
            filename: `${base.code}-LESSON.mp3`,
            model: undefined,
            prompt: initialPrompt,
          });
          audioAnalysis = {
            provider: 'openai_fallback',
            reason: [error, geminiError]
              .map((e) => (e instanceof Error ? e.message : 'unknown'))
              .join(' | '),
          };
        }
      }
    } else if (provider === 'gemini') {
      const result = await transcribeWithGeminiAudio(env, {
        audio: audioBuffer,
        filename: `${base.code}-LESSON.mp3`,
        mimeType: 'audio/mpeg',
        lessonCode: base.code,
        model: body?.model,
      });
      transcription = result.transcription;
      audioAnalysis = {
        provider: 'gemini',
        model: transcription.model,
        titleEn: result.analysis.titleEn,
        titleFr: result.analysis.titleFr,
        summaryFr: result.analysis.summaryFr,
        transcriptFr: result.analysis.transcriptFr,
        speakers: result.analysis.speakers ?? [],
        segments: result.analysis.segments ?? [],
        pedagogicalNotes: result.analysis.pedagogicalNotes ?? [],
      };
    } else {
      resolvedProvider = 'openai';
      transcription = await transcribeWithOpenAI(env, {
        audio: audioBuffer,
        filename: `${base.code}-LESSON.mp3`,
        model: body?.model,
        prompt: initialPrompt,
      });
    }
  } catch (error) {
    const message = error instanceof RunPodTranscriptionError
      || error instanceof DeepgramTranscriptionError
      || error instanceof OpenAITranscriptionError
      || error instanceof GeminiAudioError
      ? error.message
      : 'Transcription impossible';
    return err(message, 502);
  }

  // Diarisation disponible → reconstruction de la SEULE 1ʳᵉ lecture (locuteur par
  // locuteur, question/affirmation), puis annotation audio : genre (hauteur de voix)
  // et émotion/ton par réplique. L'annotation ne retranscrit rien → aucun mot perdu.
  let dialogue: DialogueLine[] = [];
  const diarizedSpeakers = Array.from(
    new Set(
      transcription.segments
        .map((segment) => segment.speaker)
        .filter((speaker): speaker is string => Boolean(speaker)),
    ),
  );
  if (diarizedSpeakers.length) {
    dialogue = buildAssimilDialogue(
      transcription.segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        speaker: segment.speaker,
      })),
    );

    const analysis = await analyzeAssimilDialogueAudio(env, {
      audio: audioBuffer,
      lines: dialogue.map((line) => ({ speakerLabel: line.speakerLabel, text: line.text })),
    }).catch(() => ({ genders: {}, annotations: [] }));

    dialogue = applyDialogueAnalysis(dialogue, {
      genderBySpeaker: analysis.genders,
      annotations: analysis.annotations,
    });

    // Traduction FR phrase par phrase (DeepSeek), stockée par réplique pour le bouton "Afficher FR".
    const translations = await translateLinesToFrench(
      env,
      dialogue.map((line) => line.text),
    ).catch(() => dialogue.map(() => ''));
    dialogue = dialogue.map((line, i) => ({ ...line, textFr: translations[i] ?? '' }));

    audioAnalysis = {
      ...(audioAnalysis ?? {}),
      provider: resolvedProvider,
      model: transcription.model,
      diarization: transcription.diarization,
      speakerGenders: analysis.genders,
      dialogue,
    };
  }

  // Transcript visible = 1ʳᵉ lecture étiquetée par locuteur si diarisation dispo,
  // sinon repli sur la transcription complète préservée.
  const firstReadingTranscript = dialogue.length
    ? formatAssimilDialogue(dialogue)
    : preserveAssimilTranscript(transcription.text);
  // Entrée de génération = texte brut de la 1ʳᵉ lecture (sans préfixe locuteur).
  const generationInput = dialogue.length
    ? dialogue.map((line) => line.text).join('\n')
    : cleanAssimilTranscript(transcription.text);

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    transcript: firstReadingTranscript,
    transcriptSource: `${resolvedProvider}:${transcription.model}`,
    transcriptionJobId: null,
    transcriptionStatus: null,
    audioAnalysis,
  });

  if (body?.generate) {
    const cleanedTranscript = generationInput;
    const preservedTranscript = firstReadingTranscript;
    const artifactResult = await generateArtifactResponse(env, index, base.level, cleanedTranscript);
    if (!artifactResult.ok) return artifactResult.response;
    const { artifact } = artifactResult;
    if (artifact) {
      await upsertAssimilLesson(env, index, {
        status: 'generated',
        titleEn: artifact.titleEn,
        titleFr: artifact.titleFr,
        transcript: preservedTranscript,
        transcriptSource: `${resolvedProvider}:${transcription.model}`,
        transcriptionJobId: null,
        transcriptionStatus: null,
        audioAnalysis,
        artifact,
        generatedBy: artifactResult.generatedBy,
      });
    }
  }

  const row = await getAssimilLessonRow(env, index);
  return json({
    ok: true,
    cached: false,
    transcription: {
      model: transcription.model,
      provider: transcription.provider ?? resolvedProvider,
      device: transcription.device,
      computeType: transcription.computeType,
      language: transcription.language,
      languageProbability: transcription.languageProbability,
      duration: transcription.duration,
      segmentCount: transcription.segments.length,
      durationMs: transcription.durationMs,
      wordTimestamps: transcription.wordTimestamps,
      audioFeatures: transcription.audioFeatures,
      diarization: transcription.diarization,
      speakerCount: diarizedSpeakers.length,
      previewSegments: provider === 'runpod' ? transcription.segments.slice(0, 8) : undefined,
    },
    dialogue,
    lesson: rowToLesson(row, index),
  });
}

export async function handleAssimilTranscriptionStatus(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const row = await getAssimilLessonRow(env, index);
  const jobId = row?.transcription_job_id?.trim();
  if (!jobId) return err('Aucun job de transcription pour cette leçon', 404);

  let status;
  try {
    status = await getRunPodTranscriptionStatus(env, jobId, row?.transcript_source ?? undefined);
  } catch (error) {
    const message = error instanceof RunPodTranscriptionError
      ? error.message
      : 'Statut RunPod impossible';
    return err(message, 502);
  }

  if (status.status === 'COMPLETED' && status.transcription) {
    const transcription = status.transcription;
    const cleanedTranscript = cleanAssimilTranscript(transcription.text);
    await upsertAssimilLesson(env, index, {
      status: 'transcript_ready',
      transcript: cleanedTranscript,
      transcriptSource: `runpod:${transcription.model}`,
      transcriptionStatus: status.status,
      audioAnalysis: {
        provider: transcription.provider ?? 'runpod',
        model: transcription.model,
        language: transcription.language,
        languageProbability: transcription.languageProbability,
        duration: transcription.duration,
        durationMs: transcription.durationMs,
        device: transcription.device,
        computeType: transcription.computeType,
        wordTimestamps: transcription.wordTimestamps,
        audioFeatures: transcription.audioFeatures,
        diarization: transcription.diarization,
        segments: transcription.segments,
      },
    });
  } else {
    await upsertAssimilLesson(env, index, {
      status: 'transcribing',
      transcriptionStatus: status.status,
    });
  }

  const updated = await getAssimilLessonRow(env, index);
  return json({
    ok: true,
    job: {
      id: status.id ?? jobId,
      status: status.status,
      error: status.error,
    },
    completed: status.status === 'COMPLETED',
    lesson: rowToLesson(updated, index),
  });
}

export async function handleGenerateAssimilLesson(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<{
    force?: boolean;
    model?: string;
    provider?: AssimilGenerationProvider;
    transcript?: string;
  }>().catch(() => null);
  const existing = await getAssimilLessonRow(env, index);

  if (!body?.force && hasGeneratedArtifact(existing)) {
    return json({ ok: true, cached: true, lesson: rowToLesson(existing, index) });
  }

  const transcript = body?.transcript?.trim() || existing?.transcript?.trim();
  if (!transcript || transcript.length < 20) {
    return err('Transcript requis avant génération pédagogique', 428);
  }

  const base = formatLesson(index);
  const provider = body?.provider === 'deepseek' ? 'deepseek' : DEFAULT_PEDAGOGY_PROVIDER;
  const artifactResult = await generateArtifactResponse(env, index, base.level, transcript, provider, body?.model);
  if (!artifactResult.ok) return artifactResult.response;
  const { artifact } = artifactResult;

  await upsertAssimilLesson(env, index, {
    status: 'generated',
    titleEn: artifact.titleEn,
    titleFr: artifact.titleFr,
    transcript,
    transcriptSource: existing?.transcript_source ?? (body?.transcript ? 'request' : null),
    artifact,
    generatedBy: artifactResult.generatedBy,
  });

  const row = await getAssimilLessonRow(env, index);
  return json({ ok: true, cached: false, lesson: rowToLesson(row, index) });
}

export async function handleResetAssimilGeneratedArtifacts(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  type ResetArtifactsBody = {
    dryRun?: boolean;
    generatedByPrefix?: string;
  };
  const body = await req.json<ResetArtifactsBody>().catch((): ResetArtifactsBody => ({}));
  const generatedByPrefix = body.generatedByPrefix?.trim() || 'deepseek';
  const dryRun = body.dryRun !== false;
  const before = await listAssimilGeneratedArtifactsByProviderPrefix(env, generatedByPrefix);

  if (!dryRun) {
    await resetAssimilGeneratedArtifactsByProviderPrefix(env, generatedByPrefix);
  }

  const after = dryRun
    ? before
    : await listAssimilGeneratedArtifactsByProviderPrefix(env, generatedByPrefix);

  return json({
    dryRun,
    generatedByPrefix,
    ok: true,
    resetCount: dryRun ? 0 : Math.max(0, before.length - after.length),
    targetCount: before.length,
    targets: before.slice(0, 50),
  });
}

function artifactSummary(artifact: AssimilLessonArtifact) {
  return {
    exerciseCount: artifact.exercises?.length ?? 0,
    noteCount: artifact.notes?.length ?? 0,
    objectiveCount: artifact.objectives?.length ?? 0,
    recyclingTargetCount: artifact.recyclingTargets?.length ?? 0,
    sentenceCount: artifact.sentences?.length ?? 0,
    titleEn: artifact.titleEn,
    titleFr: artifact.titleFr,
  };
}

async function runGenerationCandidate(params: {
  env: Env;
  index: number;
  level: AssimilLevel;
  model?: string;
  provider: AssimilGenerationProvider;
  transcript: string;
}) {
  const startedAt = Date.now();
  try {
    const artifact = await generateAssimilArtifact(
      params.env,
      params.index,
      params.level,
      params.transcript,
      { model: params.model, provider: params.provider },
    );

    return {
      artifact,
      durationMs: Date.now() - startedAt,
      generatedBy: generatedBy(params.provider, params.model),
      ok: true,
      provider: params.provider,
      summary: artifactSummary(artifact),
    };
  } catch (error) {
    return {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'generation_failed',
      generatedBy: generatedBy(params.provider, params.model),
      ok: false,
      provider: params.provider,
    };
  }
}

export async function handleCompareAssimilGeneration(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<{
    geminiModel?: string;
    includeArtifacts?: boolean;
    providers?: AssimilGenerationProvider[];
  }>().catch(() => null);
  const existing = await getAssimilLessonRow(env, index);
  const transcript = existing?.transcript?.trim();

  if (!transcript || transcript.length < 20) {
    return err('Transcript requis avant comparaison pédagogique', 428);
  }

  const base = formatLesson(index);
  const defaultProviders: AssimilGenerationProvider[] = ['deepseek', 'gemini'];
  const requestedProviders = body?.providers?.length
    ? body.providers.filter((provider): provider is AssimilGenerationProvider =>
      provider === 'deepseek' || provider === 'gemini')
    : defaultProviders;
  const providers: AssimilGenerationProvider[] = requestedProviders.length
    ? Array.from(new Set(requestedProviders))
    : defaultProviders;

  const results = await Promise.all(providers.map((provider) =>
    runGenerationCandidate({
      env,
      index,
      level: base.level,
      model: provider === 'gemini' ? body?.geminiModel : undefined,
      provider,
      transcript,
    })));

  return json({
    includeArtifacts: body?.includeArtifacts === true,
    lesson: {
      code: base.code,
      index,
      level: base.level,
      transcriptSource: existing?.transcript_source ?? null,
      transcriptLength: transcript.length,
    },
    ok: true,
    results: body?.includeArtifacts === true
      ? results
      : results.map((result) => {
        if (!result.ok) return result;
        return {
          durationMs: result.durationMs,
          generatedBy: result.generatedBy,
          ok: result.ok,
          provider: result.provider,
          summary: result.summary,
        };
      }),
  });
}

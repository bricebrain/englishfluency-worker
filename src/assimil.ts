import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import {
  AssimilGenerationError,
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
  upsertAssimilLesson,
  withGenerationStatus,
} from './assimilStore';

type ArtifactResult =
  | { ok: true; artifact: Awaited<ReturnType<typeof generateAssimilArtifact>> }
  | { ok: false; response: Response };

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
): Promise<ArtifactResult> {
  try {
    const artifact = await generateAssimilArtifact(env, index, level, transcript);
    return { ok: true, artifact };
  } catch (error) {
    const message = error instanceof AssimilGenerationError
      ? error.message
      : 'Génération LLM impossible';
    return { ok: false, response: err(message, 502) };
  }
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
  const limit = Math.min(Math.max(Number(body.limit ?? 8), 1), 12);
  const seen = new Set<string>();
  let promoted = 0;
  let created = 0;
  let skipped = 0;

  for (const target of artifact.recyclingTargets.slice(0, limit)) {
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
    await env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, datetime('now'), 0, 2.5, 1, datetime('now'), 1, 0, 0, 0, 1, 'learning', ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision = datetime('now'),
        status = 'learning',
        updated_at = datetime('now')
    `).bind(
      progressId,
      body.profileId,
      wordId,
      JSON.stringify([{
        date: new Date().toISOString(),
        result: 'assim_recycled',
        aiFeedback: `Recyclé depuis ${base.code}: ${artifact.titleEn || artifact.titleFr || base.title}`,
      }]),
    ).run();
    promoted += 1;
  }

  return json({ ok: true, promoted, created, skipped });
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
        generatedBy: 'deepseek-v4-flash',
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
        generatedBy: 'deepseek-v4-flash',
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

  const body = await req.json<{ transcript?: string; force?: boolean }>().catch(() => null);
  const existing = await getAssimilLessonRow(env, index);

  if (!body?.force && hasGeneratedArtifact(existing)) {
    return json({ ok: true, cached: true, lesson: rowToLesson(existing, index) });
  }

  const transcript = body?.transcript?.trim() || existing?.transcript?.trim();
  if (!transcript || transcript.length < 20) {
    return err('Transcript requis avant génération pédagogique', 428);
  }

  const base = formatLesson(index);
  const artifactResult = await generateArtifactResponse(env, index, base.level, transcript);
  if (!artifactResult.ok) return artifactResult.response;
  const { artifact } = artifactResult;

  await upsertAssimilLesson(env, index, {
    status: 'generated',
    titleEn: artifact.titleEn,
    titleFr: artifact.titleFr,
    transcript,
    transcriptSource: existing?.transcript_source ?? (body?.transcript ? 'request' : null),
    artifact,
    generatedBy: 'deepseek-v4-flash',
  });

  const row = await getAssimilLessonRow(env, index);
  return json({ ok: true, cached: false, lesson: rowToLesson(row, index) });
}

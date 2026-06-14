import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { AssimilGenerationError, generateAssimilArtifact } from './assimilGeneration';
import { OpenAITranscriptionError, transcribeWithOpenAI } from './assimilOpenAI';
import {
  RunPodTranscriptionError,
  getRunPodTranscriptionStatus,
  normalizeRunPodApiKey,
  submitRunPodTranscriptionJob,
  transcribeWithRunPod,
} from './assimilRunpod';
import { cleanAssimilTranscript } from './assimilTranscript';
import {
  LESSON_PREFIX,
  type AssimilLevel,
  TOTAL_LESSONS,
  formatLesson,
  parseLessonIndex,
  parseLimit,
  rowToLesson,
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
  const cleanedTranscript = cleanAssimilTranscript(transcript);

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    titleEn: body?.titleEn ?? null,
    titleFr: body?.titleFr ?? null,
    transcript: cleanedTranscript,
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
    provider?: 'openai' | 'runpod';
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
  const provider = body?.provider ?? 'openai';
  let transcription;
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
    } else {
      transcription = await transcribeWithOpenAI(env, {
        audio: audioBuffer,
        filename: `${base.code}-LESSON.mp3`,
        model: body?.model,
        prompt: initialPrompt,
      });
    }
  } catch (error) {
    const message = error instanceof RunPodTranscriptionError || error instanceof OpenAITranscriptionError
      ? error.message
      : 'Transcription impossible';
    return err(message, 502);
  }

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    transcript: cleanAssimilTranscript(transcription.text),
    transcriptSource: `${provider}:${transcription.model}`,
  });

  if (body?.generate) {
    const cleanedTranscript = cleanAssimilTranscript(transcription.text);
    const artifactResult = await generateArtifactResponse(env, index, base.level, cleanedTranscript);
    if (!artifactResult.ok) return artifactResult.response;
    const { artifact } = artifactResult;
    if (artifact) {
      await upsertAssimilLesson(env, index, {
        status: 'generated',
        titleEn: artifact.titleEn,
        titleFr: artifact.titleFr,
        transcript: cleanedTranscript,
        transcriptSource: `${provider}:${transcription.model}`,
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
      provider: transcription.provider ?? provider,
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
      previewSegments: provider === 'runpod' ? transcription.segments.slice(0, 8) : undefined,
    },
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

import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { generateAssimilArtifact } from './assimilGeneration';
import { transcribeWithRunPod } from './assimilRunpod';
import {
  LESSON_PREFIX,
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

async function withAvailability(env: Env, lessons: ReturnType<typeof formatLesson>[]) {
  return Promise.all(
    lessons.map(async (lesson) => ({
      ...lesson,
      available: Boolean(await env.AUDIO.head(lesson.key)),
    })),
  );
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

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    titleEn: body?.titleEn ?? null,
    titleFr: body?.titleFr ?? null,
    transcript,
    transcriptSource: body?.transcriptSource ?? 'manual',
  });

  const row = await getAssimilLessonRow(env, index);
  return json({ ok: true, lesson: rowToLesson(row, index) });
}

export async function handleTranscribeAssimilLesson(req: Request, env: Env, rawIndex: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<{ model?: string; force?: boolean; generate?: boolean }>().catch(() => null);
  const existing = await getAssimilLessonRow(env, index);
  if (!body?.force && existing?.transcript?.trim()) {
    return json({ ok: true, cached: true, lesson: rowToLesson(existing, index) });
  }

  const base = formatLesson(index);
  const audioUrl = new URL(`/audio/${base.key}`, req.url).toString();
  const transcription = await transcribeWithRunPod(env, {
    audioUrl,
    model: body?.model,
    initialPrompt: `English lesson ${base.code}. Short clear phrases for French learners.`,
  });

  if (!transcription) {
    return err('Transcription RunPod impossible ou RUNPOD_API_KEY manquant', 502);
  }

  await upsertAssimilLesson(env, index, {
    status: 'transcript_ready',
    transcript: transcription.text,
    transcriptSource: `runpod:${transcription.model}`,
  });

  if (body?.generate) {
    const artifact = await generateAssimilArtifact(env, index, base.level, transcription.text);
    if (artifact) {
      await upsertAssimilLesson(env, index, {
        status: 'generated',
        titleEn: artifact.titleEn,
        titleFr: artifact.titleFr,
        transcript: transcription.text,
        transcriptSource: `runpod:${transcription.model}`,
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
      language: transcription.language,
      languageProbability: transcription.languageProbability,
      duration: transcription.duration,
      segmentCount: transcription.segments.length,
      durationMs: transcription.durationMs,
    },
    lesson: rowToLesson(row, index),
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
  const artifact = await generateAssimilArtifact(env, index, base.level, transcript);
  if (!artifact) return err('Génération LLM impossible', 502);

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

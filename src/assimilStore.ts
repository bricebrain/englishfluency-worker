import type { Env } from './types';
import {
  formatLesson,
  safeJsonParse,
  type AssimilLesson,
  type AssimilLessonArtifact,
  type AssimilLessonRow,
  type AssimilLessonStatus,
} from './assimilModel';

export async function getAssimilLessonRow(env: Env, index: number): Promise<AssimilLessonRow | null> {
  try {
    return await env.DB.prepare(
      `SELECT * FROM assimil_lessons WHERE lesson_index = ? LIMIT 1`,
    ).bind(index).first<AssimilLessonRow>();
  } catch {
    return null;
  }
}

export async function upsertAssimilLesson(
  env: Env,
  index: number,
  values: {
    status: AssimilLessonStatus;
    titleEn?: string | null;
    titleFr?: string | null;
    transcript?: string | null;
    transcriptSource?: string | null;
    transcriptionJobId?: string | null;
    transcriptionStatus?: string | null;
    audioAnalysis?: Record<string, unknown> | null;
    artifact?: AssimilLessonArtifact | null;
    generatedBy?: string | null;
  },
): Promise<void> {
  const base = formatLesson(index);
  await env.DB.prepare(
     `INSERT INTO assimil_lessons (
       lesson_index, audio_key, level, status, title_en, title_fr,
       transcript, transcript_source, transcription_job_id, transcription_status,
       audio_json, lesson_json, generated_by, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, '{}'), COALESCE(?, '{}'), ?, datetime('now'))
     ON CONFLICT(lesson_index) DO UPDATE SET
       audio_key=excluded.audio_key,
       level=excluded.level,
       status=excluded.status,
       title_en=COALESCE(excluded.title_en, assimil_lessons.title_en),
       title_fr=COALESCE(excluded.title_fr, assimil_lessons.title_fr),
       transcript=COALESCE(excluded.transcript, assimil_lessons.transcript),
       transcript_source=COALESCE(excluded.transcript_source, assimil_lessons.transcript_source),
       transcription_job_id=CASE WHEN ? THEN excluded.transcription_job_id ELSE assimil_lessons.transcription_job_id END,
       transcription_status=CASE WHEN ? THEN excluded.transcription_status ELSE assimil_lessons.transcription_status END,
       audio_json=CASE WHEN ? THEN excluded.audio_json ELSE assimil_lessons.audio_json END,
       lesson_json=CASE WHEN ? THEN excluded.lesson_json ELSE assimil_lessons.lesson_json END,
       generated_by=COALESCE(excluded.generated_by, assimil_lessons.generated_by),
       updated_at=datetime('now')`,
  ).bind(
    index,
    base.key,
    base.level,
    values.status,
    values.titleEn ?? null,
    values.titleFr ?? null,
    values.transcript ?? null,
    values.transcriptSource ?? null,
    values.transcriptionJobId ?? null,
    values.transcriptionStatus ?? null,
    values.audioAnalysis === undefined ? null : JSON.stringify(values.audioAnalysis ?? {}),
    values.artifact === undefined ? null : JSON.stringify(values.artifact ?? {}),
    values.generatedBy ?? null,
    values.transcriptionJobId === undefined ? 0 : 1,
    values.transcriptionStatus === undefined ? 0 : 1,
    values.audioAnalysis === undefined ? 0 : 1,
    values.artifact === undefined ? 0 : 1,
  ).run();
}

export async function withGenerationStatus(env: Env, lessons: AssimilLesson[]): Promise<AssimilLesson[]> {
  if (!lessons.length) return lessons;

  try {
    const placeholders = lessons.map(() => '?').join(', ');
    const { results } = await env.DB.prepare(
      `SELECT lesson_index, status, title_en, title_fr, updated_at
       FROM assimil_lessons
       WHERE lesson_index IN (${placeholders})`,
    ).bind(...lessons.map((lesson) => lesson.index)).all<{
      lesson_index: number;
      status: AssimilLessonStatus;
      title_en: string | null;
      title_fr: string | null;
      updated_at: string | null;
    }>();

    const byIndex = new Map(results.map((row) => [row.lesson_index, row]));
    return lessons.map((lesson) => {
      const row = byIndex.get(lesson.index);
      return {
        ...lesson,
        status: row?.status ?? 'audio_ready',
        artifactAvailable: row?.status === 'generated',
        titleEn: row?.title_en ?? null,
        titleFr: row?.title_fr ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    });
  } catch {
    return lessons.map((lesson) => ({
      ...lesson,
      status: 'audio_ready' as AssimilLessonStatus,
      artifactAvailable: false,
    }));
  }
}

export function hasGeneratedArtifact(row: AssimilLessonRow | null): boolean {
  if (!row || row.status !== 'generated') return false;
  return Object.keys(safeJsonParse<Record<string, unknown>>(row.lesson_json, {})).length > 0;
}

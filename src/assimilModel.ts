export type AssimilLevel = 'A1' | 'A2' | 'B1' | 'B2';
export type AssimilLessonStatus = 'audio_ready' | 'transcript_ready' | 'generated';

export interface AssimilLesson {
  id: string;
  index: number;
  code: string;
  title: string;
  level: AssimilLevel;
  stageLabel: string;
  key: string;
  audioUrl: string;
  available?: boolean;
  status?: AssimilLessonStatus;
  artifactAvailable?: boolean;
  titleEn?: string | null;
  titleFr?: string | null;
  updatedAt?: string | null;
}

export interface AssimilLessonRow {
  lesson_index: number;
  audio_key: string;
  level: AssimilLevel;
  status: AssimilLessonStatus;
  title_en: string | null;
  title_fr: string | null;
  transcript: string | null;
  transcript_source: string | null;
  lesson_json: string;
  generated_by: string | null;
  generation_version: number;
  created_at: string;
  updated_at: string;
}

export interface AssimilLessonArtifact {
  titleEn: string;
  titleFr: string;
  summaryFr: string;
  objectives: string[];
  sentences: {
    id: string;
    textEn: string;
    textFr: string;
    focus: string;
    pronunciationTipFr: string;
  }[];
  notes: {
    id: string;
    topic: string;
    explanationFr: string;
    examples: { en: string; fr: string }[];
  }[];
  exercises: {
    id: string;
    type: 'dictation' | 'fill_blank' | 'translation' | 'shadowing';
    instructionFr: string;
    items: {
      prompt: string;
      answer: string;
      hintFr?: string;
      focus?: string;
    }[];
  }[];
  recyclingTargets: {
    term: string;
    reasonFr: string;
    skill: 'vocabulary' | 'grammar' | 'listening' | 'speaking';
  }[];
}

export const LESSON_PREFIX = 'audio-book-lesson';
export const TOTAL_LESSONS = 101;

export function levelForIndex(index: number): AssimilLevel {
  if (index <= 20) return 'A1';
  if (index <= 45) return 'A2';
  if (index <= 70) return 'B1';
  return 'B2';
}

function stageForLevel(level: AssimilLevel): string {
  const stages: Record<AssimilLevel, string> = {
    A1: 'Fondations',
    A2: 'Automatismes',
    B1: 'Autonomie',
    B2: 'Fluidité',
  };
  return stages[level];
}

export function formatLesson(index: number): AssimilLesson {
  const code = `L${String(index).padStart(3, '0')}`;
  const level = levelForIndex(index);
  const key = `${LESSON_PREFIX}/${code}-LESSON.mp3`;

  return {
    id: `assimil_audio_${String(index).padStart(3, '0')}`,
    index,
    code,
    title: `Leçon Assimil ${String(index).padStart(3, '0')}`,
    level,
    stageLabel: stageForLevel(level),
    key,
    audioUrl: `/audio/${key}`,
  };
}

export function parseLessonIndex(raw: string): number | null {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= TOTAL_LESSONS) return null;
  return parsed;
}

export function parseLimit(raw: string | null): number {
  if (!raw) return TOTAL_LESSONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return TOTAL_LESSONS;
  return Math.max(1, Math.min(TOTAL_LESSONS, Math.floor(parsed)));
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function rowToLesson(row: AssimilLessonRow | null, index: number) {
  const base = formatLesson(index);
  if (!row) {
    return {
      ...base,
      status: 'audio_ready' as AssimilLessonStatus,
      titleEn: null,
      titleFr: null,
      transcript: null,
      transcriptSource: null,
      artifact: null,
      generatedBy: null,
      updatedAt: null,
    };
  }

  return {
    ...base,
    status: row.status,
    titleEn: row.title_en,
    titleFr: row.title_fr,
    transcript: row.transcript,
    transcriptSource: row.transcript_source,
    artifact: safeJsonParse<AssimilLessonArtifact | null>(row.lesson_json, null),
    generatedBy: row.generated_by,
    updatedAt: row.updated_at,
  };
}

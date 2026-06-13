import type { Env } from './types';
import { json } from './utils';

type AssimilLevel = 'A1' | 'A2' | 'B1' | 'B2';

interface AssimilLesson {
  id: string;
  index: number;
  code: string;
  title: string;
  level: AssimilLevel;
  stageLabel: string;
  key: string;
  audioUrl: string;
  available?: boolean;
}

const LESSON_PREFIX = 'audio-book-lesson';
const TOTAL_LESSONS = 101;

function levelForIndex(index: number): AssimilLevel {
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

function formatLesson(index: number): AssimilLesson {
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

function parseLimit(raw: string | null): number {
  if (!raw) return TOTAL_LESSONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return TOTAL_LESSONS;
  return Math.max(1, Math.min(TOTAL_LESSONS, Math.floor(parsed)));
}

async function withAvailability(env: Env, lessons: AssimilLesson[]): Promise<AssimilLesson[]> {
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

  if (checkAvailability) {
    lessons = await withAvailability(env, lessons);
  }

  return json({
    items: lessons,
    total: lessons.length,
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

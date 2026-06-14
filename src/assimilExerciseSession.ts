import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import {
  formatLesson,
  parseLessonIndex,
  safeJsonParse,
  type AssimilLessonArtifact,
} from './assimilModel';
import { getAssimilLessonRow } from './assimilStore';

type ExerciseResult = 'correct' | 'almost' | 'wrong' | 'done';

interface AssimilExerciseAttempt {
  answer: string;
  attempts: number;
  exerciseId: string;
  exerciseType: AssimilLessonArtifact['exercises'][number]['type'];
  expected: string;
  focus?: string;
  hintFr?: string;
  itemIndex: number;
  prompt: string;
  revealed: boolean;
  result: ExerciseResult;
}

interface AssimilExerciseSessionBody {
  durationSec?: number;
  exerciseId: string;
  exerciseType: AssimilLessonArtifact['exercises'][number]['type'];
  profileId: string;
  score: number;
  total: number;
  attempts: AssimilExerciseAttempt[];
}

function isoNow(): string {
  return new Date().toISOString();
}

function eventId(profileId: string, contentId: string): string {
  return `${profileId}_${contentId}_${crypto.randomUUID()}`;
}

function slugForId(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56) || crypto.randomUUID();
}

function normalizeSentence(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function skillForExercise(type: AssimilExerciseSessionBody['exerciseType']): 'listening' | 'speaking' | 'grammar' {
  if (type === 'dictation') return 'listening';
  if (type === 'shadowing') return 'speaking';
  return 'grammar';
}

function shouldRecycleAttempt(attempt: AssimilExerciseAttempt): boolean {
  return attempt.result === 'wrong' || attempt.result === 'almost' || attempt.attempts > 1 || attempt.revealed;
}

function findTranslation(artifact: AssimilLessonArtifact | null, expected: string, fallback: string): string {
  const normalized = normalizeSentence(expected).toLowerCase();
  const sentence = artifact?.sentences?.find((entry) => (
    normalizeSentence(entry.textEn).toLowerCase() === normalized
    || normalizeSentence(entry.textEn).toLowerCase().includes(normalized)
    || normalized.includes(normalizeSentence(entry.textEn).toLowerCase())
  ));
  return sentence?.textFr || fallback;
}

async function promoteWeakAttempt(params: {
  artifact: AssimilLessonArtifact | null;
  attempt: AssimilExerciseAttempt;
  env: Env;
  lessonCode: string;
  lessonLevel: string;
  profileId: string;
}): Promise<{ created: boolean; promoted: boolean; wordId: string | null }> {
  const expected = normalizeSentence(params.attempt.expected);
  if (!expected || expected.length < 2) return { created: false, promoted: false, wordId: null };

  const wordId = `assim_${params.lessonCode.toLowerCase()}_exercise_${slugForId(expected)}`;
  const translation = findTranslation(params.artifact, expected, params.attempt.hintFr || params.attempt.focus || expected);
  const grammarHint = params.attempt.focus || params.attempt.hintFr || `Revoir cette phrase depuis ${params.lessonCode}`;

  const insertWord = await params.env.DB.prepare(`
    INSERT OR IGNORE INTO words (
      id, mot, type, niveau, traduction, examples, tags, audio_uk, audio_us, frequence, updated_at
    ) VALUES (?, ?, 'phrase', ?, ?, ?, ?, '', '', 5, datetime('now'))
  `).bind(
    wordId,
    expected,
    params.lessonLevel,
    grammarHint,
    JSON.stringify([{ en: expected, fr: translation }]),
    JSON.stringify(['assimil', params.lessonCode.toLowerCase(), params.attempt.exerciseType]),
  ).run();

  const now = isoNow();
  const progressId = `${params.profileId}_${wordId}`;
  await params.env.DB.prepare(`
    INSERT INTO word_progress (
      id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
      derniere_revision, seen_count, success_count, almost_count, fail_count,
      level, status, review_history, updated_at
    ) VALUES (?, ?, ?, datetime('now'), 0, 2.35, 1, datetime('now'), 1, 0, ?, ?, 1, 'learning', ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      prochaine_revision = datetime('now'),
      almost_count = almost_count + ?,
      fail_count = fail_count + ?,
      seen_count = seen_count + 1,
      status = 'learning',
      review_history = ?,
      updated_at = datetime('now')
  `).bind(
    progressId,
    params.profileId,
    wordId,
    params.attempt.result === 'almost' ? 1 : 0,
    params.attempt.result === 'wrong' ? 1 : 0,
    JSON.stringify([{
      date: now,
      result: 'assim_exercise_weak',
      aiFeedback: `${params.lessonCode} · ${params.attempt.exerciseType}: ${params.attempt.focus || params.attempt.hintFr || 'phrase a consolider'}`,
    }]),
    params.attempt.result === 'almost' ? 1 : 0,
    params.attempt.result === 'wrong' ? 1 : 0,
    JSON.stringify([{
      date: now,
      result: 'assim_exercise_weak',
      aiFeedback: `${params.lessonCode} · ${params.attempt.exerciseType}: ${params.attempt.focus || params.attempt.hintFr || 'phrase a consolider'}`,
    }]),
  ).run();

  return {
    created: (insertWord.meta?.changes ?? 0) > 0,
    promoted: true,
    wordId,
  };
}

export async function handleAssimilExerciseSession(
  req: Request,
  env: Env,
  rawIndex: string,
): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const index = parseLessonIndex(rawIndex);
  if (index === null) return err('lesson index invalide', 400);

  const body = await req.json<AssimilExerciseSessionBody>().catch(() => null);
  if (!body?.profileId || !body.exerciseId || !body.exerciseType || !Array.isArray(body.attempts)) {
    return err('profileId, exerciseId, exerciseType et attempts requis', 400);
  }

  const base = formatLesson(index);
  const row = await getAssimilLessonRow(env, index);
  const artifact = row?.lesson_json
    ? safeJsonParse<AssimilLessonArtifact | null>(row.lesson_json, null)
    : null;
  const weakAttempts = body.attempts.filter(shouldRecycleAttempt);
  let created = 0;
  let promoted = 0;
  const wordIds: string[] = [];

  for (const attempt of weakAttempts.slice(0, 8)) {
    const result = await promoteWeakAttempt({
      artifact,
      attempt,
      env,
      lessonCode: base.code,
      lessonLevel: base.level,
      profileId: body.profileId,
    });
    if (result.created) created += 1;
    if (result.promoted) promoted += 1;
    if (result.wordId) wordIds.push(result.wordId);
  }

  const score = body.total > 0 ? Math.max(0, Math.min(1, body.score / body.total)) : 0;
  const contentId = `${base.code}:${body.exerciseId}`;
  const payload = {
    lessonCode: base.code,
    lessonIndex: index,
    exerciseId: body.exerciseId,
    exerciseType: body.exerciseType,
    total: body.total,
    score: body.score,
    weakCount: weakAttempts.length,
    promotedWordIds: wordIds,
    attempts: body.attempts.map((attempt) => ({
      answer: attempt.answer,
      attempts: attempt.attempts,
      expected: attempt.expected,
      focus: attempt.focus,
      itemIndex: attempt.itemIndex,
      prompt: attempt.prompt,
      revealed: attempt.revealed,
      result: attempt.result,
    })),
  };

  await env.DB.prepare(`
    INSERT INTO learning_events (
      id, profile_id, module, event_type, skill, content_id, score, duration_sec, payload, occurred_at
    ) VALUES (?, ?, 'listen', 'review_word', ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId(body.profileId, contentId),
    body.profileId,
    skillForExercise(body.exerciseType),
    contentId,
    score,
    body.durationSec ?? null,
    JSON.stringify(payload),
    isoNow(),
  ).run();

  return json({
    ok: true,
    created,
    promoted,
    weakCount: weakAttempts.length,
    wordIds,
  });
}

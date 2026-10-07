import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { parseDbDate } from './srs';
import {
  formatLesson,
  parseLessonIndex,
  safeJsonParse,
  type AssimilLessonArtifact,
} from './assimilModel';
import { getAssimilLessonRow } from './assimilStore';

// Politique de recyclage automatique (VOCABULARY_LEARNING_EVOLUTION.md) :
// maximum 2 à 3 unités de forte valeur par exercice, priorité aux réponses
// fausses, révélées et aux hésitations répétées.
const RECYCLE_CAP = 3;

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
  // Shadowing validé manuellement ('done') : pratique, pas une preuve — l'app
  // l'envoie avec revealed=true puisque le modèle est toujours visible.
  if (attempt.result === 'done') return false;
  return attempt.result === 'wrong' || attempt.result === 'almost' || attempt.attempts > 1 || attempt.revealed;
}

// Sévérité décroissante : wrong+revealed > wrong > almost+revealed > almost > hésitations.
function attemptSeverity(attempt: AssimilExerciseAttempt): number {
  let severity = 0;
  if (attempt.result === 'wrong') severity += 3;
  if (attempt.result === 'almost') severity += 2;
  if (attempt.revealed) severity += 2;
  if (attempt.attempts > 1) severity += 1;
  if (attempt.attempts > 2) severity += 1;
  return severity;
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

  // Déduplication : réutilise un mot existant (phrase déjà recyclée dans une
  // autre leçon ou un autre exercice) au lieu de créer un doublon d'unité.
  const existingWord = await params.env.DB.prepare(
    'SELECT id FROM words WHERE LOWER(mot) = LOWER(?) LIMIT 1',
  ).bind(expected).first<{ id: string }>();

  const wordId = existingWord?.id ?? `assim_${params.lessonCode.toLowerCase()}_exercise_${slugForId(expected)}`;
  const translation = findTranslation(params.artifact, expected, params.attempt.hintFr || params.attempt.focus || expected);
  const grammarHint = params.attempt.focus || params.attempt.hintFr || `Revoir cette phrase depuis ${params.lessonCode}`;

  let insertChanges = 0;
  if (!existingWord) {
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
    insertChanges = insertWord.meta?.changes ?? 0;
  }

  const now = isoNow();
  const progressId = `${params.profileId}_${wordId}`;
  const weakEntry = {
    date: now,
    result: 'assim_exercise_weak',
    aiFeedback: `${params.lessonCode} · ${params.attempt.exerciseType}: ${params.attempt.focus || params.attempt.hintFr || 'phrase a consolider'}`,
  };

  const existingProgress = await params.env.DB.prepare(
    'SELECT prochaine_revision, review_history FROM word_progress WHERE id = ?',
  ).bind(progressId).first<{ prochaine_revision: string; review_history: string }>();

  if (existingProgress) {
    // Une nouvelle faiblesse complète l'historique au lieu de l'écraser, et une
    // unité déjà programmée n'est pas remise à due-now : due demain au plus tôt,
    // jamais reculée si elle était déjà due plus tôt.
    let history: unknown[] = [];
    try { history = JSON.parse(existingProgress.review_history || '[]'); } catch { /* keep empty */ }
    const nextHistory = [...(Array.isArray(history) ? history : []), weakEntry].slice(-20);

    const candidateMs = Date.now() + 1 * 86400000;
    const existingMs = parseDbDate(existingProgress.prochaine_revision);
    const prochaine = existingMs !== null && existingMs < candidateMs
      ? existingProgress.prochaine_revision
      : new Date(candidateMs).toISOString();

    await params.env.DB.prepare(`
      UPDATE word_progress SET
        prochaine_revision = ?,
        almost_count = almost_count + ?,
        fail_count = fail_count + ?,
        seen_count = seen_count + 1,
        status = 'learning',
        review_history = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      prochaine,
      params.attempt.result === 'almost' ? 1 : 0,
      params.attempt.result === 'wrong' ? 1 : 0,
      JSON.stringify(nextHistory),
      progressId,
    ).run();

    return { created: insertChanges > 0, promoted: true, wordId };
  }

  // Nouvelle unité : due immédiatement, historique initial.
  await params.env.DB.prepare(`
    INSERT INTO word_progress (
      id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
      derniere_revision, seen_count, success_count, almost_count, fail_count,
      level, status, review_history, updated_at
    ) VALUES (?, ?, ?, datetime('now'), 0, 2.35, 1, datetime('now'), 1, 0, ?, ?, 1, 'learning', ?, datetime('now'))
  `).bind(
    progressId,
    params.profileId,
    wordId,
    params.attempt.result === 'almost' ? 1 : 0,
    params.attempt.result === 'wrong' ? 1 : 0,
    JSON.stringify([weakEntry]),
  ).run();

  return {
    created: insertChanges > 0,
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
  // Recyclage qualitatif : les tentatives faibles sont triées par sévérité puis
  // limitées aux unités de plus forte valeur (2-3 max).
  const weakAttempts = body.attempts
    .filter(shouldRecycleAttempt)
    .sort((a, b) => attemptSeverity(b) - attemptSeverity(a));
  let created = 0;
  let promoted = 0;
  const wordIds: string[] = [];

  for (const attempt of weakAttempts.slice(0, RECYCLE_CAP)) {
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

  // Pas de score pour le shadowing auto-validé : il gonflerait la moyenne orale.
  const score = body.exerciseType === 'shadowing'
    ? null
    : body.total > 0 ? Math.max(0, Math.min(1, body.score / body.total)) : 0;
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

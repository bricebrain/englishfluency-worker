/**
 * Routes SRS (Spaced Repetition System)
 * GET  /srs/session?profileId=&limit=   — mots de la session du jour (dus + nouveaux, ≤100)  ← PRINCIPAL
 * GET  /srs/stats?profileId=            — stats globales légères (streak, due count…)
 * POST /srs/review                      — enregistre une révision
 * POST /srs/calibrate                   — calibration CEFR server-side (remplace srs/promote)
 * GET  /srs/progress?profileId=         — tous les mots (usage admin/debug uniquement)
 * POST /srs/promote                     — promotion en masse legacy (conservé pour compat)
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

interface WordProgressRow {
  id: string; profile_id: string; word_id: string;
  prochaine_revision: string; intervalle: number; facilite: number;
  repetitions: number; derniere_revision: string | null;
  seen_count: number; success_count: number; almost_count: number; fail_count: number;
  level: number; status: string; review_history: string;
}

interface WordRow {
  id: string; mot: string; type: string; niveau: string; traduction: string | null;
  ipa_uk: string | null; ipa_us: string | null;
  // Computed via json_extract(examples, '$[0].en|fr') — colonnes réelles = examples TEXT JSON
  exemple_en: string | null; exemple_fr: string | null;
  examples: string;   // JSON brut [{en,fr}] — parsé avant envoi au client
  audio_uk: string; audio_us: string;
}

interface DailyRow { day: string; count: number; }

// GET /srs/progress?profileId=xxx
export async function handleGetSrsProgress(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';

  const [wordsResult, progressResult, historyResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, mot, type, niveau, traduction, ipa_uk, ipa_us,
        json_extract(examples, '$[0].en') AS exemple_en,
        json_extract(examples, '$[0].fr') AS exemple_fr,
        examples, audio_uk, audio_us
       FROM words ORDER BY niveau ASC, frequence DESC`
    ).all<WordRow>(),
    env.DB.prepare('SELECT * FROM word_progress WHERE profile_id = ?').bind(profileId).all<WordProgressRow>(),
    env.DB.prepare('SELECT day, count FROM review_history_daily WHERE profile_id = ? ORDER BY day DESC LIMIT 60').bind(profileId).all<DailyRow>(),
  ]);

  const progressMap = new Map(progressResult.results.map((p) => [p.word_id, p]));
  const now = new Date().toISOString();

  const words = wordsResult.results.map((word) => {
    const p = progressMap.get(word.id);
    let parsedExamples: { en: string; fr: string }[] = [];
    try { parsedExamples = JSON.parse(word.examples || '[]'); } catch { /* keep empty */ }
    return {
      ...word,
      examples: parsedExamples,
      prochaine_revision: p?.prochaine_revision ?? now,
      intervalle: p?.intervalle ?? 0,
      facilite: p?.facilite ?? 2.5,
      repetitions: p?.repetitions ?? 0,
      derniere_revision: p?.derniere_revision ?? null,
      seen_count: p?.seen_count ?? 0,
      success_count: p?.success_count ?? 0,
      almost_count: p?.almost_count ?? 0,
      fail_count: p?.fail_count ?? 0,
      level: p?.level ?? 0,
      status: p?.status ?? 'new',
      review_history: (() => { try { return JSON.parse(p?.review_history ?? '[]'); } catch { return []; } })(),
    };
  });

  const reviewHistory = Object.fromEntries(historyResult.results.map((r) => [r.day, r.count]));

  return json({ words, reviewHistory });
}

// POST /srs/review
export async function handleSrsReview(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string;
    wordId: string;
    word: Record<string, unknown>; // SrsWord complet mis à jour par l'app
    day: string;
    count: number;
  }>().catch(() => null);

  if (!body?.profileId || !body?.wordId || !body?.word) return err('profileId, wordId, word requis');

  const w = body.word;
  const progressId = `${body.profileId}_${body.wordId}`;

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision=excluded.prochaine_revision, intervalle=excluded.intervalle,
        facilite=excluded.facilite, repetitions=excluded.repetitions,
        derniere_revision=excluded.derniere_revision, seen_count=excluded.seen_count,
        success_count=excluded.success_count, almost_count=excluded.almost_count,
        fail_count=excluded.fail_count, level=excluded.level, status=excluded.status,
        review_history=excluded.review_history, updated_at=datetime('now')
    `).bind(
      progressId, body.profileId, body.wordId,
      w.prochaine_revision, w.intervalle, w.facilite, w.repetitions,
      w.derniere_revision ?? null, w.seen_count, w.success_count, w.almost_count, w.fail_count,
      w.level, w.status, JSON.stringify(w.review_history ?? []),
    ),
    env.DB.prepare(`
      INSERT INTO review_history_daily (id, profile_id, day, count) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET count=excluded.count
    `).bind(`${body.profileId}_${body.day}`, body.profileId, body.day, body.count),
  ]);

  return json({ ok: true });
}

// POST /srs/promote  — calibration : promotion en masse
export async function handleSrsPromote(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string;
    words: Array<Record<string, unknown>>;
  }>().catch(() => null);

  if (!body?.profileId || !Array.isArray(body?.words)) return err('profileId et words requis');

  const stmts = body.words.map((w) => {
    const progressId = `${body.profileId}_${w.id}`;
    return env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision=excluded.prochaine_revision, intervalle=excluded.intervalle,
        facilite=excluded.facilite, repetitions=excluded.repetitions,
        derniere_revision=excluded.derniere_revision, seen_count=excluded.seen_count,
        success_count=excluded.success_count, level=excluded.level,
        status=excluded.status, review_history=excluded.review_history, updated_at=datetime('now')
    `).bind(
      progressId, body.profileId, w.id,
      w.prochaine_revision, w.intervalle, w.facilite, w.repetitions,
      w.derniere_revision ?? null, w.seen_count, w.success_count, w.almost_count, w.fail_count,
      w.level, w.status, JSON.stringify(w.review_history ?? []),
    );
  });

  // D1 batch max 100
  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }

  return json({ ok: true, promoted: body.words.length });
}

// GET /srs/stats?profileId=xxx
export async function handleSrsStats(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const today = new Date().toISOString().slice(0, 10);

  const [dueResult, learnedResult, totalResult, historyResult] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM word_progress WHERE profile_id = ? AND repetitions > 0 AND prochaine_revision <= datetime('now')`
    ).bind(profileId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM word_progress WHERE profile_id = ? AND repetitions > 0`
    ).bind(profileId).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) as count FROM words`).first<{ count: number }>(),
    env.DB.prepare(
      'SELECT day, count FROM review_history_daily WHERE profile_id = ? ORDER BY day DESC LIMIT 60'
    ).bind(profileId).all<DailyRow>(),
  ]);

  const reviewHistory = Object.fromEntries(historyResult.results.map((r) => [r.day, r.count]));
  const reviewedToday = reviewHistory[today] ?? 0;

  // Calcul streak
  let streak = 0;
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (true) {
    const key = d.toISOString().slice(0, 10);
    if ((reviewHistory[key] ?? 0) > 0) { streak++; d.setDate(d.getDate() - 1); }
    else break;
    if (streak > 365) break;
  }
  if (reviewedToday > 0) streak++;

  const learnedCount = learnedResult?.count ?? 0;
  const totalCount = totalResult?.count ?? 0;

  return json({
    dueCount: dueResult?.count ?? 0,
    learnedCount,
    // Mots non encore appris = total - appris (inclut mots jamais touchés)
    newCount: Math.max(0, totalCount - learnedCount),
    reviewedToday,
    streak,
  });
}

// ─── Helpers partagés ────────────────────────────────────────────────────────

function parseWordRow(word: WordRow, p: WordProgressRow | undefined, now: string) {
  let parsedExamples: { en: string; fr: string }[] = [];
  try { parsedExamples = JSON.parse(word.examples || '[]'); } catch { /* keep empty */ }
  return {
    ...word,
    examples: parsedExamples,
    prochaine_revision: p?.prochaine_revision ?? now,
    intervalle: p?.intervalle ?? 0,
    facilite: p?.facilite ?? 2.5,
    repetitions: p?.repetitions ?? 0,
    derniere_revision: p?.derniere_revision ?? null,
    seen_count: p?.seen_count ?? 0,
    success_count: p?.success_count ?? 0,
    almost_count: p?.almost_count ?? 0,
    fail_count: p?.fail_count ?? 0,
    level: p?.level ?? 0,
    status: p?.status ?? 'new',
    review_history: (() => { try { return JSON.parse(p?.review_history ?? '[]'); } catch { return []; } })(),
  };
}

// ─── GET /srs/session?profileId=&limit= ─────────────────────────────────────
// Retourne UNIQUEMENT les mots nécessaires pour la session du jour :
//   1. Tous les mots dus (prochaine_revision ≤ now, repetitions > 0)
//   2. Nouveaux mots (jamais vus) pour compléter jusqu'à `limit` (défaut 100)
// Taille typique : 40-100 mots → ~45 KB vs 4 MB pour /srs/progress complet.

interface SessionWordRow extends WordRow {
  prochaine_revision: string; intervalle: number; facilite: number;
  repetitions: number; derniere_revision: string | null;
  seen_count: number; success_count: number; almost_count: number; fail_count: number;
  level: number; status: string; review_history: string;
}

export async function handleSrsSession(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const profileId = params.get('profileId') ?? 'default';
  const limit = Math.min(parseInt(params.get('limit') ?? '100', 10), 200);

  const SELECT_WORD = `
    json_extract(w.examples, '$[0].en') AS exemple_en,
    json_extract(w.examples, '$[0].fr') AS exemple_fr,
    w.examples, w.audio_uk, w.audio_us`;

  // 1. Mots dus (dans word_progress, repetitions > 0, révision dépassée)
  const dueResult = await env.DB.prepare(`
    SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD},
      wp.prochaine_revision, wp.intervalle, wp.facilite, wp.repetitions,
      wp.derniere_revision, wp.seen_count, wp.success_count, wp.almost_count, wp.fail_count,
      wp.level, wp.status, wp.review_history
    FROM words w
    INNER JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    WHERE wp.repetitions > 0 AND wp.prochaine_revision <= datetime('now')
    ORDER BY wp.prochaine_revision ASC
    LIMIT ?
  `).bind(profileId, limit).all<SessionWordRow>();

  const dueWords = dueResult.results.map((w) => {
    let parsedExamples: { en: string; fr: string }[] = [];
    try { parsedExamples = JSON.parse(w.examples || '[]'); } catch { /* keep empty */ }
    let review_history: unknown[] = [];
    try { review_history = JSON.parse(w.review_history || '[]'); } catch { /* keep empty */ }
    return { ...w, examples: parsedExamples, review_history };
  });

  // 2. Nouveaux mots pour compléter la session (jamais dans word_progress)
  const newLimit = Math.max(0, limit - dueWords.length);
  let newWords: ReturnType<typeof parseWordRow>[] = [];

  if (newLimit > 0) {
    const newResult = await env.DB.prepare(`
      SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD}
      FROM words w
      LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
      WHERE wp.id IS NULL
      ORDER BY w.frequence DESC, w.niveau ASC
      LIMIT ?
    `).bind(profileId, newLimit).all<WordRow>();

    const now = new Date().toISOString();
    newWords = newResult.results.map((w) => parseWordRow(w, undefined, now));
  }

  // 3. Historique de révision (60 jours) — léger
  const historyResult = await env.DB.prepare(
    'SELECT day, count FROM review_history_daily WHERE profile_id = ? ORDER BY day DESC LIMIT 60'
  ).bind(profileId).all<DailyRow>();

  const reviewHistory = Object.fromEntries(historyResult.results.map((r) => [r.day, r.count]));

  return json({
    words: [...dueWords, ...newWords],
    reviewHistory,
    dueCount: dueWords.length,
    newCount: newWords.length,
  });
}

// ─── POST /srs/calibrate ─────────────────────────────────────────────────────
// Calibration CEFR server-side : promeut en masse les mots en dessous du niveau estimé.
// Body: { profileId: string, estimatedLevel: 'A1'|'A2'|'B1'|'B2'|'C1', confidence: number }
// Évite de charger 4617 mots côté app — tout se passe dans D1.

const LEVEL_RANK: Record<string, number> = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4 };
const RANK_LEVELS: Record<number, string[]> = {
  0: ['A1'],
  1: ['A1', 'A2'],
  2: ['A1', 'A2', 'B1'],
  3: ['A1', 'A2', 'B1', 'B2'],
  4: ['A1', 'A2', 'B1', 'B2', 'C1'],
};

export async function handleSrsCalibrate(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string;
    estimatedLevel: string;
    confidence: number;
  }>().catch(() => null);

  if (!body?.profileId || !body?.estimatedLevel) return err('profileId et estimatedLevel requis');
  if ((body.confidence ?? 0) < 72) return json({ ok: true, promoted: 0, reason: 'confidence trop faible' });

  const estimatedRank = LEVEL_RANK[body.estimatedLevel.toUpperCase()] ?? 0;
  const promoteUnderRank = body.confidence >= 84 ? estimatedRank - 1 : estimatedRank - 2;
  if (promoteUnderRank < 0) return json({ ok: true, promoted: 0, reason: 'niveau trop bas pour calibration' });

  const levelsToPromote = RANK_LEVELS[promoteUnderRank] ?? ['A1'];
  const placeholders = levelsToPromote.map(() => '?').join(', ');
  const prochaine = new Date(Date.now() + 14 * 86400000).toISOString();
  const reviewHistory = JSON.stringify([{ date: new Date().toISOString(), result: 'success', aiFeedback: 'Calibration automatique.' }]);

  // 1. Upsert word_progress pour tous les mots éligibles (niveau ≤ promoteUnderRank, jamais vus)
  const eligibleResult = await env.DB.prepare(`
    SELECT w.id FROM words w
    LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    WHERE w.niveau IN (${placeholders})
      AND (wp.id IS NULL OR (wp.seen_count <= 1 AND wp.fail_count = 0 AND wp.status = 'new'))
    ORDER BY w.frequence DESC
    LIMIT 160
  `).bind(body.profileId, ...levelsToPromote).all<{ id: string }>();

  if (!eligibleResult.results.length) return json({ ok: true, promoted: 0 });

  const stmts = eligibleResult.results.map(({ id }) => {
    const progressId = `${body.profileId}_${id}`;
    return env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, ?, 14, 2.6, 2, datetime('now'), 3, 3, 0, 0, 4, 'known', ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision=excluded.prochaine_revision, intervalle=14, facilite=2.6,
        repetitions=2, derniere_revision=datetime('now'), seen_count=3, success_count=3,
        level=4, status='known', review_history=excluded.review_history, updated_at=datetime('now')
    `).bind(progressId, body.profileId, id, prochaine, reviewHistory);
  });

  for (let i = 0; i < stmts.length; i += 100) {
    await env.DB.batch(stmts.slice(i, i + 100));
  }

  return json({ ok: true, promoted: eligibleResult.results.length });
}

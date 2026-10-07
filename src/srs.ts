/**
 * Routes SRS (Spaced Repetition System)
 * GET  /srs/session?profileId=&limit=   — mots de la session du jour (dus + nouveaux, ≤100)  ← PRINCIPAL
 * GET  /srs/stats?profileId=            — stats globales légères (streak, due count…)
 * POST /srs/review                      — enregistre une révision
 * POST /srs/calibrate                   — calibration CEFR server-side (remplace srs/promote)
 * POST /srs/known                       — « Je connais déjà » : dépriorisation + vérification différée
 * GET  /srs/triage?profileId=&limit=    — candidats A1 évidents pour la session de tri rapide
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
  const levelFloor = await loadLevelFloorRank(env, profileId);

  const [dueResult, learnedResult, totalResult, historyResult] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM word_progress wp
       INNER JOIN words w ON w.id = wp.word_id
       WHERE wp.profile_id = ? AND wp.repetitions > 0 AND wp.prochaine_revision <= datetime('now')
         AND ${DUE_WORD_LEVEL_FILTER_SQL}`
    ).bind(profileId, levelFloor).first<{ count: number }>(),
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

// ─── Priorité d'apprentissage (A1 évidents) ──────────────────────────────────
// Mots A1 « pièges » : simples en apparence mais complexes dans leurs usages.
// Jamais dépriorisés automatiquement (VOCABULARY_LEARNING_EVOLUTION.md).
const TRICKY_A1_WORDS = new Set(['as', 'like', 'get', 'set', 'still', 'just', 'yet', 'would', 'rather']);

// ─── Plancher de niveau (profil) ─────────────────────────────────────────────
// Le niveau choisi dans le profil remplace la calibration : les mots situés au
// strictement sous (niveau − 1) ne sont plus proposés
// comme nouveaux et ne reviennent en révision que s'ils ont déjà posé problème.
// Toujours conservés : mots pièges, unités Assimil, mots triés « À apprendre ».
const CEFR_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1'];
const NIVEAU_RANK_SQL = "CASE w.niveau WHEN 'A1' THEN 0 WHEN 'A2' THEN 1 WHEN 'B1' THEN 2 WHEN 'B2' THEN 3 ELSE 4 END";
const TRICKY_SQL_LIST = [...TRICKY_A1_WORDS].map((word) => `'${word}'`).join(', ');

export async function loadLevelFloorRank(env: Env, profileId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT level FROM profiles WHERE id = ?')
    .bind(profileId).first<{ level: string }>();
  const rank = CEFR_ORDER.indexOf((row?.level ?? 'B1').toUpperCase());
  return Math.max(0, (rank === -1 ? 2 : rank) - 1);
}

/** Filtre SQL (1 paramètre : plancher) des nouveaux mots — alias `w`. */
export const NEW_WORD_LEVEL_FILTER_SQL = `(
  ${NIVEAU_RANK_SQL} >= ?
  OR w.id LIKE 'assim_%'
  OR LOWER(w.mot) IN (${TRICKY_SQL_LIST})
)`;

/** Filtre SQL (1 paramètre : plancher) des mots dus — alias `w` et `wp`. */
export const DUE_WORD_LEVEL_FILTER_SQL = `NOT (
  ${NIVEAU_RANK_SQL} < ?
  AND wp.fail_count = 0
  AND wp.almost_count = 0
  AND w.id NOT LIKE 'assim_%'
  AND LOWER(w.mot) NOT IN (${TRICKY_SQL_LIST})
  AND wp.review_history NOT LIKE '%triage_focus%'
)`;

// Score explicable : 0 = probablement déjà acquis (dépriorisé), 1 = apprentissage prioritaire.
// Ne déclare jamais un mot connu — sert uniquement à ordonner les nouveaux mots.
export function computeLearningPriorityScore(word: {
  mot: string; type: string | null; niveau: string; frequence?: number | null;
  fail_count?: number | null;
}): number {
  let score = 1;
  const mot = (word.mot ?? '').toLowerCase();
  if (word.niveau === 'A1') score -= 0.3;
  if ((word.frequence ?? 3) >= 5) score -= 0.15;
  if (mot.length > 0 && mot.length <= 4) score -= 0.1;
  if (word.type && ['determiner', 'pronoun', 'number', 'color', 'preposition'].includes(word.type)) score -= 0.1;
  if ((word.fail_count ?? 0) > 0) score += 0.2;
  if (TRICKY_A1_WORDS.has(mot)) score += 0.25;
  return Math.max(0, Math.min(1, score));
}

export function rankNewWordsByPriority<T extends { mot: string; type: string | null; niveau: string; frequence?: number | null }>(
  words: T[],
  limit: number,
): T[] {
  if (words.length <= limit) return words;
  return [...words]
    .map((word, order) => ({ word, order, score: computeLearningPriorityScore(word) }))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .slice(0, limit)
    .map((entry) => entry.word);
}

export async function handleSrsSession(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const profileId = params.get('profileId') ?? 'default';
  const limit = Math.min(parseInt(params.get('limit') ?? '100', 10), 200);
  const levelFloor = await loadLevelFloorRank(env, profileId);

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
      AND ${DUE_WORD_LEVEL_FILTER_SQL}
    ORDER BY
      CASE WHEN w.id LIKE 'assim_%' THEN 0 ELSE 1 END,
      wp.prochaine_revision ASC
    LIMIT ?
  `).bind(profileId, levelFloor, limit).all<SessionWordRow>();

  const dueWords = dueResult.results.map((w) => {
    let parsedExamples: { en: string; fr: string }[] = [];
    try { parsedExamples = JSON.parse(w.examples || '[]'); } catch { /* keep empty */ }
    let review_history: unknown[] = [];
    try { review_history = JSON.parse(w.review_history || '[]'); } catch { /* keep empty */ }
    return { ...w, examples: parsedExamples, review_history };
  });

  // 2. Nouveaux mots pour compléter la session (jamais dans word_progress)
  //    Pool élargi (×3) puis tri par priorité : les A1 probablement acquis
  //    arrivent en fin de session au lieu d'être exclus automatiquement.
  const newLimit = Math.max(0, limit - dueWords.length);
  let newWords: ReturnType<typeof parseWordRow>[] = [];

  if (newLimit > 0) {
    const candidateLimit = Math.min(newLimit * 3, 200);
    const newResult = await env.DB.prepare(`
      SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD}
      FROM words w
      LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
      WHERE wp.id IS NULL
        AND ${NEW_WORD_LEVEL_FILTER_SQL}
      ORDER BY
        CASE WHEN w.id LIKE 'assim_%' THEN 0 ELSE 1 END,
        w.frequence DESC,
        w.niveau ASC
      LIMIT ?
    `).bind(profileId, levelFloor, candidateLimit).all<WordRow>();

    const now = new Date().toISOString();
    newWords = rankNewWordsByPriority(newResult.results, newLimit).map((w) => parseWordRow(w, undefined, now));
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

// ─── POST /srs/known ─────────────────────────────────────────────────────────
// « Je connais déjà » : déclaration utilisateur, en batch (session de tri ou carte).
// Body: { profileId: string, wordIds: string[], source?: 'user_marked_known' | 'triage_focus' }
//  - user_marked_known → dépriorisation : seen+1, success+1, vérification dans 7-15 j
//  - triage_focus      → « À apprendre » : priorisation, due demain au plus tôt
// Ne passe JAMAIS directement à status='known' : l'entrée review_history
// 'user_marked_known' sert de métadonnée known_candidate, la promotion se fait
// après au moins une vérification réussie (escalade gérée côté app dans reviewWord).

interface KnownHistoryEntry {
  date?: string;
  result?: string;
}

function parseKnownHistory(raw: string | null | undefined): KnownHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// prochaine_revision est stockée dans deux formats (ISO et datetime('now')) —
// normalise avant comparaison.
export function parseDbDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// Jitter déterministe 7..15 jours par mot pour étaler les vérifications.
function deferredVerificationDays(wordId: string): number {
  let hash = 0;
  for (let i = 0; i < wordId.length; i += 1) {
    hash = (hash * 31 + wordId.charCodeAt(i)) & 0x7fffffff;
  }
  return 7 + (hash % 9);
}

export async function handleSrsKnown(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string;
    wordIds: string[];
    source?: 'user_marked_known' | 'triage_focus';
  }>().catch(() => null);

  if (!body?.profileId || !Array.isArray(body?.wordIds) || body.wordIds.length === 0) {
    return err('profileId et wordIds requis');
  }

  const source = body.source === 'triage_focus' ? 'triage_focus' : 'user_marked_known';
  const wordIds = [...new Set(
    body.wordIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
  )].slice(0, 100);

  const now = new Date();
  const nowIso = now.toISOString();
  let updated = 0;
  let alreadyMarked = 0;

  for (const wordId of wordIds) {
    const progressId = `${body.profileId}_${wordId}`;
    const existing = await env.DB.prepare(
      'SELECT * FROM word_progress WHERE id = ?',
    ).bind(progressId).first<WordProgressRow>();

    const history = parseKnownHistory(existing?.review_history);

    // Anti double-marquage : un mot déjà déclaré connu n'est pas re-dépriorisé.
    if (source === 'user_marked_known' && history.some((entry) => entry?.result === 'user_marked_known')) {
      alreadyMarked += 1;
      continue;
    }

    const nextHistory = [
      ...history,
      { date: nowIso, result: source === 'triage_focus' ? 'triage_focus' : 'user_marked_known' },
    ].slice(-20);

    if (!existing) {
      const delayDays = source === 'triage_focus' ? 1 : deferredVerificationDays(wordId);
      const prochaine = new Date(now.getTime() + delayDays * 86400000).toISOString();
      await env.DB.prepare(`
        INSERT INTO word_progress (
          id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
          derniere_revision, seen_count, success_count, almost_count, fail_count,
          level, status, review_history, updated_at
        ) VALUES (?, ?, ?, ?, ?, 2.5, 1, ?, ?, ?, 0, 0, ?, 'learning', ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')
      `).bind(
        progressId,
        body.profileId,
        wordId,
        prochaine,
        source === 'triage_focus' ? 0 : 7,
        source === 'triage_focus' ? null : nowIso,
        source === 'triage_focus' ? 0 : 1,
        source === 'triage_focus' ? 0 : 1,
        source === 'triage_focus' ? 0 : 1,
        JSON.stringify(nextHistory),
      ).run();
      updated += 1;
      continue;
    }

    if (source === 'triage_focus') {
      // Priorisation : due demain, sans avancer une unité déjà due plus tôt.
      const candidateMs = now.getTime() + 1 * 86400000;
      const existingMs = parseDbDate(existing.prochaine_revision);
      const prochaine = existingMs !== null && existingMs < candidateMs
        ? existing.prochaine_revision
        : new Date(candidateMs).toISOString();
      await env.DB.prepare(`
        UPDATE word_progress SET
          prochaine_revision = ?,
          repetitions = MAX(repetitions, 1),
          status = 'learning',
          review_history = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).bind(prochaine, JSON.stringify(nextHistory), progressId).run();
      updated += 1;
      continue;
    }

    // user_marked_known sur une unité existante : incrément léger + échéance
    // différée, sans jamais régresser une échéance plus lointaine ni un statut known.
    const candidateMs = now.getTime() + deferredVerificationDays(wordId) * 86400000;
    const existingMs = parseDbDate(existing.prochaine_revision);
    const prochaine = existingMs !== null && existingMs > candidateMs
      ? existing.prochaine_revision
      : new Date(candidateMs).toISOString();

    await env.DB.prepare(`
      UPDATE word_progress SET
        prochaine_revision = ?,
        derniere_revision = ?,
        seen_count = seen_count + 1,
        success_count = success_count + 1,
        status = CASE WHEN status = 'known' THEN 'known' ELSE 'learning' END,
        review_history = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).bind(prochaine, nowIso, JSON.stringify(nextHistory), progressId).run();
    updated += 1;
  }

  // Journal unique des preuves : la déclaration est un événement, pas une maîtrise.
  await env.DB.prepare(`
    INSERT INTO learning_events (
      id, profile_id, module, event_type, skill, content_id, payload, occurred_at
    ) VALUES (?, ?, 'review', 'word_marked_known', 'vocabulary', ?, ?, ?)
  `).bind(
    `${body.profileId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    body.profileId,
    wordIds[0] ?? null,
    JSON.stringify({ source, wordIds, updated, alreadyMarked }),
    nowIso,
  ).run();

  return json({ ok: true, updated, alreadyMarked });
}

// ─── GET /srs/triage?profileId=&limit= ───────────────────────────────────────
// Candidats de la session de tri rapide : mots A1 très fréquents, jamais vus
// (ou à peine), hors mots pièges et hors mots déjà marqués/connus.
// Un score faible ne déclare pas un mot connu — l'utilisateur trie lui-même.

interface TriageWordRow {
  id: string;
  mot: string;
  traduction: string | null;
  niveau: string;
  type: string | null;
  frequence: number;
}

export async function handleSrsTriage(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const profileId = params.get('profileId') ?? 'default';
  const parsedLimit = parseInt(params.get('limit') ?? '60', 10);
  const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 60, 10), 120);

  const trickyPlaceholders = [...TRICKY_A1_WORDS].map(() => '?').join(', ');

  const result = await env.DB.prepare(`
    SELECT w.id, w.mot, w.traduction, w.niveau, w.type, w.frequence
    FROM words w
    LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    WHERE w.niveau = 'A1'
      AND w.frequence >= 4
      AND LOWER(w.mot) NOT IN (${trickyPlaceholders})
      AND (
        wp.id IS NULL
        OR (
          wp.seen_count <= 1
          AND wp.fail_count = 0
          AND wp.status != 'known'
          AND wp.review_history NOT LIKE '%user_marked_known%'
          AND wp.review_history NOT LIKE '%triage_focus%'
        )
      )
    ORDER BY w.frequence DESC, LENGTH(w.mot) ASC, w.mot ASC
    LIMIT ?
  `).bind(profileId, ...TRICKY_A1_WORDS, limit).all<TriageWordRow>();

  return json({ words: result.results, total: result.results.length });
}

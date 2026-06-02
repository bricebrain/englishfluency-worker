/**
 * Routes dictée
 * GET  /dictation?profileId=&limit=
 * POST /dictation
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

interface DictationRow {
  id: string; profile_id: string; level: string; sentence: string;
  user_input: string | null; score: number; item_count: number;
  correct_count: number; minor_count: number; incorrect_count: number;
  errors: string; global_feedback_fr: string;
  generation_source: string | null; correction_source: string;
  audio_r2_key: string | null; created_at: string;
}

const MAX_SESSIONS = 120;

// GET /dictation?profileId=&limit=50
export async function handleGetDictation(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const profileId = url.searchParams.get('profileId') ?? 'default';
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 120);

  const { results } = await env.DB.prepare(
    'SELECT * FROM dictation_sessions WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?'
  ).bind(profileId, limit).all<DictationRow>();

  return json({ sessions: results.map(deserializeSession) });
}

// POST /dictation
export async function handleSaveDictation(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string; level: string; sentence: string; userInput?: string;
    score: number; itemCount: number; correctCount: number; minorCount: number;
    incorrectCount: number; errors?: unknown[]; globalFeedbackFr?: string;
    generationSource?: string; correctionSource?: string; audioR2Key?: string;
  }>().catch(() => null);

  if (!body?.profileId || body?.score === undefined) return err('profileId et score requis');

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // Supprime les plus anciennes si besoin
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM dictation_sessions WHERE profile_id = ?'
  ).bind(body.profileId).first<{ c: number }>();

  if ((countRow?.c ?? 0) >= MAX_SESSIONS) {
    await env.DB.prepare(
      `DELETE FROM dictation_sessions WHERE id IN (
        SELECT id FROM dictation_sessions WHERE profile_id = ? ORDER BY created_at ASC LIMIT 10
      )`
    ).bind(body.profileId).run();
  }

  await env.DB.prepare(`
    INSERT INTO dictation_sessions (
      id, profile_id, level, sentence, user_input, score, item_count,
      correct_count, minor_count, incorrect_count, errors, global_feedback_fr,
      generation_source, correction_source, audio_r2_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, body.profileId, body.level ?? 'A1', body.sentence ?? '',
    body.userInput ?? null, body.score, body.itemCount ?? 0,
    body.correctCount ?? 0, body.minorCount ?? 0, body.incorrectCount ?? 0,
    JSON.stringify(body.errors ?? []), body.globalFeedbackFr ?? '',
    body.generationSource ?? null, body.correctionSource ?? 'remote',
    body.audioR2Key ?? null,
  ).run();

  return json({ ok: true, id });
}

function deserializeSession(row: DictationRow) {
  return {
    id: row.id,
    profileId: row.profile_id,
    level: row.level,
    sentence: row.sentence,
    userInput: row.user_input,
    score: row.score,
    scorePercent: row.score,
    itemCount: row.item_count,
    correctCount: row.correct_count,
    minorCount: row.minor_count,
    incorrectCount: row.incorrect_count,
    errors: (() => { try { return JSON.parse(row.errors); } catch { return []; } })(),
    globalFeedbackFr: row.global_feedback_fr,
    generationSource: row.generation_source,
    correctionSource: row.correction_source,
    audioR2Key: row.audio_r2_key,
    createdAt: row.created_at,
  };
}

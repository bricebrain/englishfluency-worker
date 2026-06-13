/**
 * Routes Lingvist (cartes + calibration)
 * GET  /lingvist/cards?profileId=
 * GET  /lingvist/card/:wordId?profileId=
 * PUT  /lingvist/card/:wordId
 * GET  /calibration?profileId=
 * POST /calibration
 * DELETE /calibration?profileId=
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

interface CardRow {
  id: string; profile_id: string; word_id: string;
  example_en: string; lemma: string; target_pos: string;
  verb_form_label: string | null; expected_answer: string;
  sentence_with_gap: string; sentence_full: string;
  translation_fr: string; grammar_hint: string;
  input_placeholder: string; source: string; schema_version: number;
}

interface CalibrationRow { profile_id: string; data: string; updated_at: string; }

// GET /lingvist/cards?profileId=xxx
export async function handleGetLingvistCards(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const { results } = await env.DB.prepare(
    'SELECT * FROM lingvist_cards WHERE profile_id = ?'
  ).bind(profileId).all<CardRow>();
  return json({ cards: results.map(deserializeCard) });
}

// GET /lingvist/card/:wordId?profileId=xxx
export async function handleGetLingvistCard(req: Request, env: Env, wordId: string): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const row = await env.DB.prepare(
    'SELECT * FROM lingvist_cards WHERE profile_id = ? AND word_id = ? LIMIT 1'
  ).bind(profileId, wordId).first<CardRow>();

  return json({ card: row ? deserializeCard(row) : null });
}

// PUT /lingvist/card/:wordId
export async function handleUpsertLingvistCard(req: Request, env: Env, wordId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string; exampleEn: string; lemma: string; targetPos?: string;
    verbFormLabel?: string; expectedAnswer: string; sentenceWithGap: string;
    sentenceFull: string; translationFr: string; grammarHint: string;
    inputPlaceholder: string; source?: string; schemaVersion?: number;
  }>().catch(() => null);

  if (!body?.profileId || !body?.expectedAnswer) return err('profileId et expectedAnswer requis');

  const id = `${body.profileId}_${wordId}`;

  await env.DB.prepare(`
    INSERT INTO lingvist_cards (
      id, profile_id, word_id, example_en, lemma, target_pos, verb_form_label,
      expected_answer, sentence_with_gap, sentence_full, translation_fr,
      grammar_hint, input_placeholder, source, schema_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      example_en=excluded.example_en, lemma=excluded.lemma,
      target_pos=excluded.target_pos, verb_form_label=excluded.verb_form_label,
      expected_answer=excluded.expected_answer, sentence_with_gap=excluded.sentence_with_gap,
      sentence_full=excluded.sentence_full, translation_fr=excluded.translation_fr,
      grammar_hint=excluded.grammar_hint, input_placeholder=excluded.input_placeholder,
      source=excluded.source, schema_version=excluded.schema_version,
      updated_at=datetime('now')
  `).bind(
    id, body.profileId, wordId, body.exampleEn, body.lemma,
    body.targetPos ?? 'other', body.verbFormLabel ?? null,
    body.expectedAnswer, body.sentenceWithGap, body.sentenceFull,
    body.translationFr, body.grammarHint, body.inputPlaceholder,
    body.source ?? 'remote', body.schemaVersion ?? 4,
  ).run();

  return json({ ok: true });
}

// GET /calibration?profileId=xxx
export async function handleGetCalibration(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const row = await env.DB.prepare(
    'SELECT * FROM lingvist_calibration WHERE profile_id = ?'
  ).bind(profileId).first<CalibrationRow>();

  if (!row) return json(null);

  return json((() => { try { return JSON.parse(row.data); } catch { return null; } })());
}

// POST /calibration
export async function handleSaveCalibration(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{ profileId: string; data: unknown }>().catch(() => null);
  if (!body?.profileId || !body?.data) return err('profileId et data requis');

  await env.DB.prepare(`
    INSERT INTO lingvist_calibration (profile_id, data, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(profile_id) DO UPDATE SET data=excluded.data, updated_at=datetime('now')
  `).bind(body.profileId, JSON.stringify(body.data)).run();

  return json({ ok: true });
}

// DELETE /calibration?profileId=xxx
export async function handleDeleteCalibration(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  await env.DB.prepare('DELETE FROM lingvist_calibration WHERE profile_id = ?').bind(profileId).run();
  return json({ ok: true });
}

function deserializeCard(row: CardRow) {
  return {
    wordId: row.word_id,
    exampleEn: row.example_en,
    lemma: row.lemma,
    targetPos: row.target_pos,
    verbFormLabel: row.verb_form_label,
    expectedAnswer: row.expected_answer,
    sentenceWithGap: row.sentence_with_gap,
    sentenceFull: row.sentence_full,
    translationFr: row.translation_fr,
    grammarHint: row.grammar_hint,
    inputPlaceholder: row.input_placeholder,
    source: row.source,
    schemaVersion: row.schema_version,
  };
}

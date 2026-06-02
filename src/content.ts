/**
 * Routes Contenu IA (histoires, notes grammaire, traductions, podcasts, cours)
 * GET    /content?profileId=&type=&limit=
 * POST   /content
 * DELETE /content/:id
 * PATCH  /content/:id
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

interface ContentRow {
  id: string; profile_id: string; type: string; title: string | null;
  level: string | null; topic: string | null; body: string;
  metadata: string; audio_r2_key: string | null; is_favorite: number; created_at: string;
}

const VALID_TYPES = new Set(['story', 'grammar_note', 'translation', 'podcast', 'course']);
const MAX_PER_TYPE = 50;

// GET /content?profileId=&type=story&limit=30&offset=0
export async function handleGetContent(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const profileId = url.searchParams.get('profileId') ?? 'default';
  const type = url.searchParams.get('type');
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '30'), 100);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'), 0);

  let query: D1PreparedStatement;
  if (type && VALID_TYPES.has(type)) {
    query = env.DB.prepare(
      'SELECT * FROM content WHERE profile_id = ? AND type = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(profileId, type, limit, offset);
  } else {
    query = env.DB.prepare(
      'SELECT * FROM content WHERE profile_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(profileId, limit, offset);
  }

  const { results } = await query.all<ContentRow>();

  return json({
    items: results.map(deserializeContent),
    count: results.length,
    offset,
  });
}

// POST /content
export async function handleCreateContent(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    profileId: string; id: string; type: string;
    title?: string; level?: string; topic?: string; body?: string;
    metadata?: unknown; audioR2Key?: string;
  }>().catch(() => null);

  if (!body?.profileId || !body?.id || !body?.type) return err('profileId, id, type requis');
  if (!VALID_TYPES.has(body.type)) return err(`type invalide : ${body.type}`);

  // Vérif limite par type
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM content WHERE profile_id = ? AND type = ?'
  ).bind(body.profileId, body.type).first<{ c: number }>();

  if ((countRow?.c ?? 0) >= MAX_PER_TYPE) {
    // Supprime le plus ancien
    const oldest = await env.DB.prepare(
      'SELECT id FROM content WHERE profile_id = ? AND type = ? ORDER BY created_at ASC LIMIT 1'
    ).bind(body.profileId, body.type).first<{ id: string }>();
    if (oldest) await env.DB.prepare('DELETE FROM content WHERE id = ?').bind(oldest.id).run();
  }

  await env.DB.prepare(`
    INSERT INTO content (id, profile_id, type, title, level, topic, body, metadata, audio_r2_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, body=excluded.body, metadata=excluded.metadata,
      audio_r2_key=excluded.audio_r2_key
  `).bind(
    body.id, body.profileId, body.type,
    body.title ?? null, body.level ?? null, body.topic ?? null,
    body.body ?? '', JSON.stringify(body.metadata ?? {}),
    body.audioR2Key ?? null,
  ).run();

  return json({ ok: true });
}

// DELETE /content/:id
export async function handleDeleteContent(req: Request, env: Env, id: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare('SELECT audio_r2_key FROM content WHERE id = ?').bind(id).first<{ audio_r2_key: string | null }>();
  if (row?.audio_r2_key) {
    try { await env.AUDIO.delete(row.audio_r2_key); } catch { /* best-effort */ }
  }

  await env.DB.prepare('DELETE FROM content WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// PATCH /content/:id  — toggle favori ou update partiel
export async function handlePatchContent(req: Request, env: Env, id: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{ isFavorite?: boolean; audioR2Key?: string }>().catch(() => null);
  if (!body) return err('Body invalide');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.isFavorite !== undefined) { updates.push('is_favorite = ?'); params.push(body.isFavorite ? 1 : 0); }
  if (body.audioR2Key !== undefined) { updates.push('audio_r2_key = ?'); params.push(body.audioR2Key); }

  if (!updates.length) return err('Rien à mettre à jour');

  params.push(id);
  await env.DB.prepare(`UPDATE content SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
  return json({ ok: true });
}

function deserializeContent(row: ContentRow) {
  return {
    id: row.id,
    profileId: row.profile_id,
    type: row.type,
    title: row.title,
    level: row.level,
    topic: row.topic,
    body: row.body,
    metadata: (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })(),
    audioR2Key: row.audio_r2_key,
    isFavorite: row.is_favorite === 1,
    createdAt: row.created_at,
  };
}

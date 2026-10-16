/**
 * Routes Contenu IA (histoires, notes grammaire, traductions, podcasts, cours)
 * GET    /content?profileId=&type=&limit=&view=summary
 * GET    /content/:id
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
const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 Mo

// POST /content/audio?key=prepared-content/<slug>.mp3
// Upload d'un MP3 pour l'import depuis l'atelier local (body = octets bruts).
export async function handleUploadAudio(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const key = new URL(req.url).searchParams.get('key') ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.includes('..') || key.length > 200) {
    return err('Clé R2 invalide');
  }

  const body = await req.arrayBuffer();
  if (!body.byteLength) return err('Corps vide');
  if (body.byteLength > MAX_AUDIO_BYTES) return err('Audio trop lourd (max 100 Mo)', 413);

  await env.AUDIO.put(key, body, { httpMetadata: { contentType: 'audio/mpeg' } });
  return json({ ok: true, key, size: body.byteLength });
}

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
  const summary = url.searchParams.get('view') === 'summary';

  return json({
    items: results.map(summary ? summarizeContent : deserializeContent),
    count: results.length,
    offset,
  });
}

// GET /content/:id — contenu complet (la liste en vue résumée ne contient
// ni segments, ni chunks, ni textes longs).
export async function handleGetContentItem(_req: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM content WHERE id = ?').bind(id).first<ContentRow>();
  if (!row) return err('Contenu introuvable', 404);
  return json(deserializeContent(row));
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

  // Une mise à jour (même id, ex. republication depuis l'atelier) ne doit
  // jamais faire disparaître un autre contenu : la limite par type ne
  // s'applique qu'à la création d'un nouveau contenu.
  const existing = await env.DB.prepare('SELECT id FROM content WHERE id = ?')
    .bind(body.id).first<{ id: string }>();

  if (!existing) {
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
  }

  // level/topic : mis à jour s'ils sont fournis, conservés sinon
  await env.DB.prepare(`
    INSERT INTO content (id, profile_id, type, title, level, topic, body, metadata, audio_r2_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, body=excluded.body, metadata=excluded.metadata,
      audio_r2_key=excluded.audio_r2_key,
      level=COALESCE(excluded.level, content.level),
      topic=COALESCE(excluded.topic, content.topic)
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

// Vue résumée d'un contenu pour les listes : la metadata v2 de l'atelier
// pèse ~75 Ko par contenu (segments, chunks, textes EN/FR). On garde les
// champs scalaires, les textes longs sont tronqués (aperçu) et listés dans
// `summary.truncatedKeys`, les tableaux et objets remplacés par des compteurs.
const SUMMARY_MAX_STRING = 500;
const SUMMARY_BODY_EXCERPT = 600;

function excerpt(text: string, max: number): string {
  return `${text.slice(0, max).trimEnd()}…`;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function summarizeContent(row: ContentRow) {
  const full = deserializeContent(row);
  const metadata: Record<string, unknown> = {};
  const truncatedKeys: string[] = [];
  for (const [key, value] of Object.entries(full.metadata as Record<string, unknown>)) {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') metadata[key] = value;
    else if (typeof value === 'string') {
      if (value.length <= SUMMARY_MAX_STRING) metadata[key] = value;
      else {
        metadata[key] = excerpt(value, SUMMARY_MAX_STRING);
        truncatedKeys.push(key);
      }
    }
  }
  const source = full.metadata as Record<string, unknown>;
  const segments = Array.isArray(source.segments) ? source.segments as Array<Record<string, unknown>> : [];
  // Un corps JSON structuré (leçons partagées) n'est jamais tronqué : la PWA le parse.
  const structured = full.body.trim().startsWith('{');
  const bodyTruncated = !structured && full.body.length > SUMMARY_BODY_EXCERPT;
  return {
    ...full,
    body: bodyTruncated ? excerpt(full.body, SUMMARY_BODY_EXCERPT) : full.body,
    metadata,
    summary: {
      segmentCount: segments.length,
      chunkCount: countArray(source.chunks),
      grammarPointCount: countArray(source.grammarPoints),
      hasTimings: segments.length > 0 && segments.every((s) => typeof s.startMs === 'number' && typeof s.endMs === 'number'),
      bodyTruncated,
      truncatedKeys,
    },
  };
}

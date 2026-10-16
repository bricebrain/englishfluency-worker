/**
 * Références des audios de l'atelier (`prepared-content/…`) et cycle de vie
 * (écoute active v1.2 § 8.2) :
 * - upload (`POST /content/audio?contentId=`) → `pending` ;
 * - `POST /content` → la clé du contenu passe `active`, l'ancienne `retired`
 *   (même batch D1 que l'écriture du contenu) ;
 * - suppression ou éviction du contenu → ses références `content` passent
 *   `retired`, les références `srs_card` / `transfer` restent ;
 * - tâche de nuit → supprime de R2 les clés sans référence active, ni
 *   `srs_card`, ni `transfer`, `pending` depuis 24 h ou `retired` depuis 7 jours.
 */
import type { Env } from './types';
import { err, json, isAuthorized } from './utils';

export const PREPARED_PREFIX = 'prepared-content/';
const PENDING_TTL_MS = 24 * 3600 * 1000;
const RETIRED_TTL_MS = 7 * 24 * 3600 * 1000;
const CLEANUP_BATCH = 50;

/** Horodatage au format de `datetime('now')` de SQLite (UTC). */
export function sqlTimestamp(date = new Date()): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function isPreparedKey(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.startsWith(PREPARED_PREFIX);
}

/** Propriétaire déjà enregistré d'une clé, s'il diffère de `contentId`. */
export async function foreignOwner(env: Env, key: string, contentId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT content_id FROM audio_references WHERE key = ? AND content_id <> ? LIMIT 1',
  ).bind(key, contentId).first<{ content_id: string }>();
  return row?.content_id ?? null;
}

export function pendingStatement(env: Env, key: string, contentId: string, now = sqlTimestamp()) {
  // Un nouvel upload d'une clé déjà active la laisse active ; une clé retirée
  // redevient `pending` jusqu'à sa réactivation par POST /content.
  return env.DB.prepare(`
    INSERT INTO audio_references (key, content_id, kind, ref_id, state, created_at, updated_at)
    VALUES (?, ?, 'content', ?, 'pending', ?, ?)
    ON CONFLICT(key, kind, ref_id) DO UPDATE SET
      state = CASE WHEN audio_references.state = 'active' THEN 'active' ELSE 'pending' END,
      retired_at = NULL,
      updated_at = excluded.updated_at
  `).bind(key, contentId, contentId, now, now);
}

/**
 * Instructions à exécuter dans le même batch que l'écriture du contenu :
 * active `key` (si c'est une clé de l'atelier) et retire les autres clés
 * actives de ce contenu.
 */
export function activationStatements(env: Env, contentId: string, key: string | null, now = sqlTimestamp()) {
  const statements = [
    env.DB.prepare(`
      UPDATE audio_references SET state = 'retired', retired_at = ?, updated_at = ?
      WHERE content_id = ? AND kind = 'content' AND state = 'active' AND key <> ?
    `).bind(now, now, contentId, key ?? ''),
  ];
  if (isPreparedKey(key)) {
    statements.push(env.DB.prepare(`
      INSERT INTO audio_references (key, content_id, kind, ref_id, state, created_at, updated_at)
      VALUES (?, ?, 'content', ?, 'active', ?, ?)
      ON CONFLICT(key, kind, ref_id) DO UPDATE SET state = 'active', retired_at = NULL, updated_at = excluded.updated_at
    `).bind(key, contentId, contentId, now, now));
  }
  return statements;
}

/** Retire toutes les références `content` d'un contenu supprimé. */
export function retireContentStatement(env: Env, contentId: string, now = sqlTimestamp()) {
  return env.DB.prepare(`
    UPDATE audio_references SET state = 'retired', retired_at = COALESCE(retired_at, ?), updated_at = ?
    WHERE content_id = ? AND kind = 'content' AND state <> 'retired'
  `).bind(now, now, contentId);
}

// POST /content/audio/retire  { contentId, key }
export async function handleRetireAudio(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<{ contentId?: string; key?: string }>().catch(() => null);
  const contentId = body?.contentId?.trim();
  const key = body?.key?.trim();
  if (!contentId || !key) return err('contentId et key requis');
  if (!isPreparedKey(key) || key.includes('..')) return err('Seules les clés prepared-content/ peuvent être retirées');

  const owner = await env.DB.prepare('SELECT content_id FROM audio_references WHERE key = ? LIMIT 1')
    .bind(key).first<{ content_id: string }>();
  if (!owner) return err('Clé inconnue', 404);
  if (owner.content_id !== contentId) return err('Cette clé appartient à un autre contenu', 403);

  const current = await env.DB.prepare('SELECT audio_r2_key FROM content WHERE id = ?')
    .bind(contentId).first<{ audio_r2_key: string | null }>();
  if (current?.audio_r2_key === key) return err('Clé active du contenu : publier un autre audio avant de la retirer', 409);

  const now = sqlTimestamp();
  await env.DB.prepare(`
    UPDATE audio_references SET state = 'retired', retired_at = COALESCE(retired_at, ?), updated_at = ?
    WHERE key = ? AND content_id = ? AND kind = 'content' AND state <> 'retired'
  `).bind(now, now, key, contentId).run();
  return json({ ok: true, key, state: 'retired' });
}

/**
 * Nettoyage R2 (tâche de nuit). Supprime une clé seulement si :
 * aucune référence active, aucune référence srs_card/transfer, toutes ses
 * références expirées, et aucun contenu ne la sert encore.
 */
export async function cleanupAudioReferences(env: Env, now = new Date()) {
  const pendingBefore = sqlTimestamp(new Date(now.getTime() - PENDING_TTL_MS));
  const retiredBefore = sqlTimestamp(new Date(now.getTime() - RETIRED_TTL_MS));
  const { results } = await env.DB.prepare(`
    SELECT key FROM audio_references
    WHERE key LIKE 'prepared-content/%'
      AND key NOT IN (SELECT audio_r2_key FROM content WHERE audio_r2_key IS NOT NULL)
    GROUP BY key
    HAVING SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN kind IN ('srs_card', 'transfer') THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN (state = 'pending' AND updated_at < ?)
                      OR (state = 'retired' AND retired_at < ?) THEN 0 ELSE 1 END) = 0
    LIMIT ?
  `).bind(pendingBefore, retiredBefore, CLEANUP_BATCH).all<{ key: string }>();

  const deleted: string[] = [];
  for (const { key } of results) {
    // Re-vérifié au moment de supprimer : une publication a pu réactiver la clé.
    const removed = await env.DB.prepare(`
      DELETE FROM audio_references WHERE key = ?
        AND NOT EXISTS (SELECT 1 FROM audio_references WHERE key = ? AND (state = 'active' OR kind IN ('srs_card', 'transfer')))
        AND NOT EXISTS (SELECT 1 FROM content WHERE audio_r2_key = ?)
    `).bind(key, key, key).run();
    if (!removed.meta.changes) continue;
    await env.AUDIO.delete(key);
    deleted.push(key);
  }
  return { deleted };
}

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

interface ProfileRow { id: string; name: string; level: string; daily_goal: number; created_at: string; updated_at: string; }

// GET /profile?profileId=xxx  — récupère ou crée le profil
export async function handleGetProfile(req: Request, env: Env): Promise<Response> {
  const profileId = new URL(req.url).searchParams.get('profileId') ?? 'default';
  const row = await env.DB.prepare('SELECT * FROM profiles WHERE id = ?').bind(profileId).first<ProfileRow>();
  if (!row) {
    // Auto-créé à la première demande
    await env.DB.prepare(
      `INSERT INTO profiles (id, name) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`
    ).bind(profileId, 'Profil principal').run();
    return json({ id: profileId, name: 'Profil principal', level: 'B1', daily_goal: 20 });
  }
  return json(row);
}

// POST /profile  — crée un profil
export async function handleCreateProfile(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<{ id: string; name: string; level?: string; daily_goal?: number }>().catch(() => null);
  if (!body?.id || !body?.name) return err('id et name requis');

  await env.DB.prepare(
    `INSERT INTO profiles (id, name, level, daily_goal) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, level=excluded.level, daily_goal=excluded.daily_goal, updated_at=datetime('now')`
  ).bind(body.id, body.name.trim(), body.level ?? 'B1', body.daily_goal ?? 20).run();

  return json({ ok: true });
}

// GET /profiles  — liste tous les profils
export async function handleListProfiles(_req: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM profiles ORDER BY created_at ASC').all<ProfileRow>();
  return json({ profiles: results });
}

// DELETE /profile/:id  — supprime un profil et ses données
export async function handleDeleteProfile(req: Request, env: Env, profileId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  if (profileId === 'default') return err('Impossible de supprimer le profil par défaut', 400);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM word_progress WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM review_history_daily WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM content WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM dictation_sessions WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM lingvist_cards WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM lingvist_calibration WHERE profile_id = ?').bind(profileId),
    env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(profileId),
  ]);

  return json({ ok: true });
}

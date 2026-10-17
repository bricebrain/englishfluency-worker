import type { Env, WordRow } from './types';
import { rowToWord } from './types';
import { json, err, isAuthorized } from './utils';

const VALID_NIVEAUX = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const MAX_BULK_DELETE = 200;

// ── GET /words ─────────────────────────────────────────────────────────────
// ?niveau=A1&limit=200&offset=0
export async function handleGetWords(req: Request, env: Env): Promise<Response> {
  const url    = new URL(req.url);
  const niveau = url.searchParams.get('niveau');
  const limit  = Math.min(Number(url.searchParams.get('limit')  ?? '500'), 1000);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? '0'),   0);

  const query = niveau && VALID_NIVEAUX.has(niveau)
    ? env.DB.prepare('SELECT * FROM words WHERE niveau = ? ORDER BY frequence DESC, mot ASC LIMIT ? OFFSET ?').bind(niveau, limit, offset)
    : env.DB.prepare('SELECT * FROM words ORDER BY niveau ASC, frequence DESC, mot ASC LIMIT ? OFFSET ?').bind(limit, offset);

  const { results } = await query.all<WordRow>();
  return json({ words: results.map(rowToWord), count: results.length, offset, limit });
}

// ── GET /words/count ────────────────────────────────────────────────────────
export async function handleGetCount(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT niveau, COUNT(*) as count FROM words GROUP BY niveau ORDER BY niveau ASC'
  ).all<{ niveau: string; count: number }>();

  const total = results.reduce((s, r) => s + r.count, 0);
  return json({ total, by_niveau: results });
}

// ── GET /words/sync?since=<ISO> ─────────────────────────────────────────────
// Renvoie uniquement les mots mis à jour depuis la date donnée
export async function handleSync(req: Request, env: Env): Promise<Response> {
  const since = new URL(req.url).searchParams.get('since');
  if (!since) return err('Paramètre "since" requis (ISO 8601)');

  const { results } = await env.DB.prepare(
    'SELECT * FROM words WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 500'
  ).bind(since).all<WordRow>();

  return json({ words: results.map(rowToWord), count: results.length, since });
}

// ── GET /words/:id ──────────────────────────────────────────────────────────
export async function handleGetWord(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM words WHERE id = ?').bind(id).first<WordRow>();
  if (!row) return err('Mot introuvable', 404);
  return json(rowToWord(row));
}

// ── DELETE /words ──────────────────────────────────────────────────────────
// Suppression globale : référentiel, progression SRS et cartes Lingvist.
export async function handleDeleteWords(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{ ids?: unknown }>().catch(() => null);
  if (!Array.isArray(body?.ids)) return err('Liste ids requise');
  const ids = [...new Set(body.ids
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter(Boolean))];
  if (ids.length < 1 || ids.length > MAX_BULK_DELETE) {
    return err(`Sélectionnez entre 1 et ${MAX_BULK_DELETE} mots`);
  }

  const placeholders = ids.map(() => '?').join(', ');
  const { results: words } = await env.DB.prepare(
    `SELECT id, mot FROM words WHERE id IN (${placeholders})`,
  ).bind(...ids).all<{ id: string; mot: string }>();
  const found = new Set(words.map((word) => word.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) return json({ error: 'Certains mots sont introuvables', missing }, 409);

  const [progress, cards, versions, enrichments, deleted] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM word_progress WHERE word_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM lingvist_cards WHERE word_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM vocabulary_enrichment_versions WHERE word_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM vocabulary_enrichments WHERE word_id IN (${placeholders})`).bind(...ids),
    env.DB.prepare(`DELETE FROM words WHERE id IN (${placeholders})`).bind(...ids),
  ]);

  return json({
    ok: true,
    deleted: Number(deleted.meta.changes ?? 0),
    ids,
    related: {
      wordProgress: Number(progress.meta.changes ?? 0),
      lingvistCards: Number(cards.meta.changes ?? 0),
      enrichmentVersions: Number(versions.meta.changes ?? 0),
      enrichments: Number(enrichments.meta.changes ?? 0),
    },
  });
}

// ── PATCH /words/:id/audio ──────────────────────────────────────────────────
// L'app met à jour l'URL audio après génération TTS
export async function handlePatchAudio(req: Request, id: string, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{ audio_uk?: string; audio_us?: string }>().catch(() => null);
  if (!body?.audio_uk && !body?.audio_us) return err('audio_uk ou audio_us requis');

  const now = new Date().toISOString();

  if (body.audio_uk && body.audio_us) {
    await env.DB.prepare(
      'UPDATE words SET audio_uk = ?, audio_us = ?, updated_at = ? WHERE id = ?'
    ).bind(body.audio_uk, body.audio_us, now, id).run();
  } else if (body.audio_uk) {
    await env.DB.prepare(
      'UPDATE words SET audio_uk = ?, updated_at = ? WHERE id = ?'
    ).bind(body.audio_uk, now, id).run();
  } else {
    await env.DB.prepare(
      'UPDATE words SET audio_us = ?, updated_at = ? WHERE id = ?'
    ).bind(body.audio_us, now, id).run();
  }

  return json({ id, updated: true });
}

// ── GET /words/grammar-seed?level=B1&count=30 ──────────────────────────────
// Renvoie des mots avec exemple_en/exemple_fr pour le Grammar Trainer.
// Évite d'importer le JSON 1.6MB dans le bundle app.
export async function handleGrammarSeed(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rawLevel = url.searchParams.get('level') ?? 'B1';
  const count = Math.min(Number(url.searchParams.get('count') ?? '30'), 150);

  const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const level = rawLevel.toUpperCase().match(/^(A1|A2|B1|B2|C1|C2)$/)?.[1] ?? 'B1';
  const idx = LEVEL_ORDER.indexOf(level);
  const near = [
    LEVEL_ORDER[Math.max(0, idx - 1)],
    level,
    LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, idx + 1)],
  ];
  // Génère des placeholders uniques (même si near contient des doublons, SQLite les déduplique)
  const placeholders = near.map(() => '?').join(', ');

  const { results } = await env.DB.prepare(`
    SELECT id, mot, type, niveau,
      json_extract(examples, '$[0].en') AS exemple_en,
      json_extract(examples, '$[0].fr') AS exemple_fr
    FROM words
    WHERE niveau IN (${placeholders})
      AND length(json_extract(examples, '$[0].en')) >= 8
      AND length(json_extract(examples, '$[0].fr')) >= 8
    ORDER BY RANDOM()
    LIMIT ?
  `).bind(...near, count).all<{
    id: string; mot: string; type: string | null; niveau: string;
    exemple_en: string; exemple_fr: string;
  }>();

  return json({ items: results, count: results.length });
}

// ── GET /words/random?niveau=B2&count=10 ───────────────────────────────────
export async function handleRandom(req: Request, env: Env): Promise<Response> {
  const url    = new URL(req.url);
  const niveau = url.searchParams.get('niveau');
  const count  = Math.min(Number(url.searchParams.get('count') ?? '10'), 50);

  const query = niveau && VALID_NIVEAUX.has(niveau)
    ? env.DB.prepare('SELECT * FROM words WHERE niveau = ? ORDER BY RANDOM() LIMIT ?').bind(niveau, count)
    : env.DB.prepare('SELECT * FROM words ORDER BY RANDOM() LIMIT ?').bind(count);

  const { results } = await query.all<WordRow>();
  return json({ words: results.map(rowToWord), count: results.length });
}

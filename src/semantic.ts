import { embedTexts } from './aiBudget';
import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

/**
 * Recherche dans les contenus de l'utilisateur.
 * - Recherche par le sens : passages (segments d'articles, scènes SRT, extraits de
 *   contenus préparés) encodés par bge-m3 et stockés dans Vectorize ; une requête
 *   en français trouve aussi les passages anglais de même sens.
 * - Contextes d'un mot : recherche exacte en SQL des phrases qui le contiennent,
 *   sans IA, pour l'encart « Dans tes contenus » des exercices.
 */

export type PassageSource = 'content' | 'reading' | 'srt';
const SOURCES: PassageSource[] = ['content', 'reading', 'srt'];
const EMBED_BATCH = 40;
const MAX_TEXT = 1500;

export interface Passage {
  source: PassageSource;
  refId: string;
  parentId: string;
  title: string;
  text: string;
  textFr?: string;
  level?: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Identifiant Vectorize stable et court (64 octets maximum). */
export async function vectorIdFor(source: PassageSource, refId: string): Promise<string> {
  return `${source[0]}_${(await sha256Hex(`${source}|${refId}`)).slice(0, 40)}`;
}

function clean(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

/** Découpe un texte en phrases (approximation suffisante pour l'anglais). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=["“'(\[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 1);
}

interface ContentRow { id: string; title: string | null; level: string | null; body: string; metadata: string }
interface ContentSegment { id?: string; en?: string; fr?: string }

/** Extraits d'un contenu préparé : segments bilingues regroupés par 3, sinon le texte anglais. */
export function contentPassages(row: ContentRow): Passage[] {
  const metadata = parseJson<Record<string, unknown>>(row.metadata, {});
  const title = clean(row.title, 200) || 'Contenu préparé';
  const level = clean(row.level, 8) || undefined;
  const segments = (Array.isArray(metadata.segments) ? metadata.segments as ContentSegment[] : [])
    .filter((segment) => clean(segment?.en));
  const passages: Passage[] = [];
  if (segments.length) {
    for (let start = 0; start < segments.length; start += 3) {
      const group = segments.slice(start, start + 3);
      passages.push({
        source: 'content', refId: `${row.id}#${start}`, parentId: row.id, title, level,
        text: clean(group.map((segment) => segment.en).join(' ')),
        textFr: clean(group.map((segment) => segment.fr ?? '').join(' ')) || undefined,
      });
    }
    return passages;
  }
  const english = clean(metadata.textEn, 100_000) || clean(row.body, 100_000);
  const sentences = splitSentences(english);
  for (let start = 0; start < sentences.length; start += 3) {
    passages.push({ source: 'content', refId: `${row.id}#${start}`, parentId: row.id, title, level, text: clean(sentences.slice(start, start + 3).join(' ')) });
  }
  return passages;
}

async function existingVectorIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < ids.length; start += 90) {
    const chunk = ids.slice(start, start + 90);
    const { results } = await env.DB.prepare(
      `SELECT vector_id FROM semantic_index WHERE vector_id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk).all<{ vector_id: string }>();
    results.forEach((row) => found.add(row.vector_id));
  }
  return found;
}

/** Passages pas encore indexés, toutes sources confondues, dans la limite donnée. */
async function pendingPassages(env: Env, limit: number): Promise<Passage[]> {
  const pending: Passage[] = [];

  const { results: reading } = await env.DB.prepare(`
    SELECT s.id, s.item_id, s.title, s.text, s.summary_fr, s.level, i.title AS item_title
    FROM reading_library_segments s
    JOIN reading_library_items i ON i.id = s.item_id
    LEFT JOIN semantic_index si ON si.source = 'reading' AND si.ref_id = s.id
    WHERE si.vector_id IS NULL
    LIMIT ?
  `).bind(limit).all<{ id: string; item_id: string; title: string; text: string; summary_fr: string; level: string; item_title: string }>();
  reading.forEach((row) => pending.push({
    source: 'reading', refId: row.id, parentId: row.item_id, level: row.level,
    title: clean(`${row.item_title} — ${row.title}`, 200), text: clean(row.text), textFr: clean(row.summary_fr, 600) || undefined,
  }));
  if (pending.length >= limit) return pending.slice(0, limit);

  const { results: scenes } = await env.DB.prepare(`
    SELECT sc.id, sc.episode_id, sc.text, sc.level, e.title AS episode_title
    FROM srt_scenes sc
    JOIN srt_episodes e ON e.id = sc.episode_id
    LEFT JOIN semantic_index si ON si.source = 'srt' AND si.ref_id = sc.id
    WHERE si.vector_id IS NULL
    LIMIT ?
  `).bind(limit - pending.length).all<{ id: string; episode_id: string; text: string; level: string; episode_title: string }>();
  scenes.forEach((row) => pending.push({
    source: 'srt', refId: row.id, parentId: row.episode_id, level: row.level,
    title: clean(row.episode_title, 200), text: clean(row.text),
  }));
  if (pending.length >= limit) return pending.slice(0, limit);

  const { results: contents } = await env.DB.prepare('SELECT id, title, level, body, metadata FROM content').all<ContentRow>();
  const passages = contents.flatMap(contentPassages);
  const ids = await Promise.all(passages.map((passage) => vectorIdFor(passage.source, passage.refId)));
  const indexed = await existingVectorIds(env, ids);
  passages.forEach((passage, index) => {
    if (pending.length < limit && !indexed.has(ids[index]!)) pending.push(passage);
  });
  return pending;
}

/** Supprime de l'index les passages dont la source a disparu. */
async function purgeOrphans(env: Env): Promise<number> {
  const { results } = await env.DB.prepare(`
    SELECT si.vector_id FROM semantic_index si
    WHERE (si.source = 'reading' AND NOT EXISTS (SELECT 1 FROM reading_library_segments s WHERE s.id = si.ref_id))
       OR (si.source = 'srt' AND NOT EXISTS (SELECT 1 FROM srt_scenes s WHERE s.id = si.ref_id))
       OR (si.source = 'content' AND NOT EXISTS (SELECT 1 FROM content c WHERE c.id = si.parent_id))
    LIMIT 200
  `).all<{ vector_id: string }>();
  const ids = results.map((row) => row.vector_id);
  if (!ids.length) return 0;
  await env.VECTORIZE?.deleteByIds(ids);
  for (let start = 0; start < ids.length; start += 90) {
    const chunk = ids.slice(start, start + 90);
    await env.DB.prepare(`DELETE FROM semantic_index WHERE vector_id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk).run();
  }
  return ids.length;
}

/** Indexe jusqu'à `limit` nouveaux passages. Idempotent : relançable à volonté. */
export async function indexSemanticBatch(env: Env, limit = 120): Promise<{ indexed: number; purged: number; remaining: boolean }> {
  if (!env.VECTORIZE || !env.AI) return { indexed: 0, purged: 0, remaining: false };
  const purged = await purgeOrphans(env);
  const passages = await pendingPassages(env, limit);
  let indexed = 0;
  for (let start = 0; start < passages.length; start += EMBED_BATCH) {
    const batch = passages.slice(start, start + EMBED_BATCH);
    const vectors = await embedTexts(env, batch.map((passage) => passage.text));
    if (vectors.length !== batch.length) throw new Error('Nombre de vecteurs inattendu');
    const ids = await Promise.all(batch.map((passage) => vectorIdFor(passage.source, passage.refId)));
    await env.VECTORIZE.upsert(batch.map((passage, index) => ({
      id: ids[index]!,
      values: vectors[index]!,
      metadata: {
        source: passage.source, refId: passage.refId, parentId: passage.parentId, title: passage.title,
        text: passage.text, ...(passage.textFr ? { textFr: passage.textFr } : {}), ...(passage.level ? { level: passage.level } : {}),
      },
    })));
    const hashes = await Promise.all(batch.map((passage) => sha256Hex(passage.text)));
    await env.DB.batch(batch.map((passage, index) => env.DB.prepare(`
      INSERT INTO semantic_index (vector_id, source, ref_id, parent_id, text_hash, indexed_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(vector_id) DO UPDATE SET text_hash = excluded.text_hash, indexed_at = excluded.indexed_at
    `).bind(ids[index]!, passage.source, passage.refId, passage.parentId, hashes[index]!)));
    indexed += batch.length;
  }
  return { indexed, purged, remaining: passages.length >= limit };
}

export interface SearchResult extends Passage {
  score: number;
}

export async function searchPassages(env: Env, query: string, options: { limit?: number; source?: PassageSource } = {}): Promise<SearchResult[]> {
  if (!env.VECTORIZE || !env.AI) return [];
  const [vector] = await embedTexts(env, [query]);
  if (!vector) return [];
  const result = await env.VECTORIZE.query(vector, {
    topK: Math.min(Math.max(options.limit ?? 8, 1), 20),
    returnMetadata: 'all',
    ...(options.source ? { filter: { source: options.source } } : {}),
  });
  return result.matches
    .map((match) => {
      const metadata = (match.metadata ?? {}) as Record<string, unknown>;
      return {
        score: Math.round(match.score * 1000) / 1000,
        source: (SOURCES.includes(metadata.source as PassageSource) ? metadata.source : 'content') as PassageSource,
        refId: clean(metadata.refId, 200),
        parentId: clean(metadata.parentId, 200),
        title: clean(metadata.title, 200),
        text: clean(metadata.text),
        textFr: clean(metadata.textFr) || undefined,
        level: clean(metadata.level, 8) || undefined,
      };
    })
    .filter((item) => item.text);
}

export interface WordContext {
  source: PassageSource;
  parentId: string;
  title: string;
  sentence: string;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Phrases des contenus qui contiennent réellement le mot (ou une forme fléchie simple). */
export async function findWordContexts(env: Env, word: string, limit = 3): Promise<WordContext[]> {
  const term = clean(word, 60).toLowerCase();
  if (term.length < 2) return [];
  const like = `%${term.replace(/[%_]/g, '')}%`;
  const pattern = new RegExp(`\\b${escapeRegex(term)}(?:s|es|ed|d|ing|'s)?\\b`, 'i');
  const contexts: WordContext[] = [];
  const seen = new Set<string>();

  const add = (source: PassageSource, parentId: string, title: string, text: string) => {
    for (const sentence of splitSentences(text)) {
      if (contexts.length >= limit) return;
      const key = sentence.toLowerCase();
      if (sentence.length > 260 || !pattern.test(sentence) || seen.has(key)) continue;
      seen.add(key);
      contexts.push({ source, parentId, title, sentence });
    }
  };

  const [reading, scenes, contents] = await Promise.all([
    env.DB.prepare(`
      SELECT s.item_id, s.text, i.title FROM reading_library_segments s JOIN reading_library_items i ON i.id = s.item_id
      WHERE LOWER(s.text) LIKE ? LIMIT 12
    `).bind(like).all<{ item_id: string; text: string; title: string }>(),
    env.DB.prepare(`
      SELECT sc.episode_id, sc.text, e.title FROM srt_scenes sc JOIN srt_episodes e ON e.id = sc.episode_id
      WHERE LOWER(sc.text) LIKE ? LIMIT 12
    `).bind(like).all<{ episode_id: string; text: string; title: string }>(),
    env.DB.prepare('SELECT id, title, level, body, metadata FROM content WHERE LOWER(metadata) LIKE ? OR LOWER(body) LIKE ? LIMIT 8')
      .bind(like, like).all<ContentRow>(),
  ]);

  contents.results.forEach((row) => contentPassages(row).forEach((passage) => add('content', row.id, passage.title, passage.text)));
  scenes.results.forEach((row) => add('srt', row.episode_id, row.title, row.text));
  reading.results.forEach((row) => add('reading', row.item_id, row.title, row.text));
  return contexts.slice(0, limit);
}

// ── Routes ──────────────────────────────────────────────────────────────────

export async function handleSemanticSearch(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const query = clean(params.get('q'), 300);
  if (query.length < 2) return err('Requête trop courte');
  const source = params.get('source') as PassageSource | null;
  try {
    const results = await searchPassages(env, query, {
      limit: Number(params.get('limit') ?? 8),
      source: source && SOURCES.includes(source) ? source : undefined,
    });
    return json({ query, results });
  } catch (error) {
    console.warn('search/semantic', error instanceof Error ? error.message : error);
    return err('Recherche indisponible', 502);
  }
}

export async function handleWordContexts(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const word = clean(params.get('word'), 60);
  if (!word) return err('word requis');
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 3), 1), 6);
  return json({ word, contexts: await findWordContexts(env, word, limit) });
}

export async function handleSemanticIndex(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get('limit') ?? 120), 1), 400);
  return json(await indexSemanticBatch(env, limit));
}

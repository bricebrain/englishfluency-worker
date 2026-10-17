import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

const STATUSES = new Set(['correct', 'incomplete', 'incorrect_as_standalone', 'incorrect', 'ambiguous']);
const KINDS = new Set(['collocation', 'grammar_pattern', 'phrasal_verb', 'idiom', 'expression']);
const MAX_ENTRIES = 50;

type Enrichment = Record<string, unknown> & { id: string };
type SourceRow = { id: string; mot: string; traduction: string | null; type: string; niveau: string };

function nonEmpty(value: unknown, max = 600): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validateEntry(entry: unknown, source: SourceRow): string[] {
  if (!entry || typeof entry !== 'object') return ['entrée non objet'];
  const item = entry as Record<string, unknown>;
  const errors: string[] = [];
  if (item.id !== source.id) errors.push('id différent de la source');
  if (item.originalWord !== source.mot) errors.push('originalWord différent de la source');
  if (item.originalTranslation !== (source.traduction ?? '')) errors.push('originalTranslation différent de la source');
  if (item.originalType !== source.type) errors.push('originalType différent de la source');
  for (const field of ['lemma', 'displayForm', 'primaryTranslation']) {
    if (!nonEmpty(item[field], 300)) errors.push(`${field} invalide`);
  }
  if (!nonEmpty(item.partOfSpeech, 40)) errors.push('partOfSpeech invalide');
  if (!nonEmpty(item.translationStatus, 40) || !STATUSES.has(item.translationStatus)) errors.push('translationStatus invalide');
  if (typeof item.reviewRequired !== 'boolean') errors.push('reviewRequired doit être booléen');
  if (item.reviewNote !== null && item.reviewNote !== undefined && typeof item.reviewNote !== 'string') errors.push('reviewNote invalide');
  if (!Array.isArray(item.senses) || item.senses.length < 1 || item.senses.length > 3) {
    errors.push('senses doit contenir 1 à 3 éléments');
    return errors;
  }
  const senseKeys = new Set<string>();
  item.senses.forEach((sense, index) => {
    const value = sense as Record<string, unknown>;
    if (!sense || typeof sense !== 'object') {
      errors.push(`senses[${index}] invalide`);
      return;
    }
    if (!nonEmpty(value.senseKey, 100) || senseKeys.has(value.senseKey)) errors.push(`senses[${index}].senseKey invalide`);
    else senseKeys.add(value.senseKey);
    if (!nonEmpty(value.partOfSpeech, 40)) errors.push(`senses[${index}].partOfSpeech invalide`);
    for (const field of ['translation', 'exampleEn', 'exampleFr']) if (!nonEmpty(value[field], 500)) errors.push(`senses[${index}].${field} invalide`);
  });
  if (!Array.isArray(item.collocations) || item.collocations.length > 4) errors.push('collocations doit contenir 0 à 4 éléments');
  else item.collocations.forEach((collocation, index) => {
    const value = collocation as Record<string, unknown>;
    if (!collocation || typeof collocation !== 'object') {
      errors.push(`collocations[${index}] invalide`);
      return;
    }
    if (!nonEmpty(value.en, 240) || !nonEmpty(value.fr, 300)) errors.push(`collocations[${index}] invalide`);
    if (!nonEmpty(value.kind, 40) || !KINDS.has(value.kind)) errors.push(`collocations[${index}].kind invalide`);
    if (!nonEmpty(value.senseKey, 100) || !senseKeys.has(value.senseKey)) errors.push(`collocations[${index}].senseKey invalide`);
  });
  if ((item.partOfSpeech === 'modal_verb' || ['can','could','may','might','must','shall','should','will','would'].includes(String(item.lemma).toLowerCase()))
      && String(item.displayForm).toLowerCase().startsWith('to ')) errors.push('un modal ne peut pas commencer par « to »');
  return errors;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, '0')).join('');
}

export async function handlePublishVocabularyBatch(req: Request, env: Env, batchId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  if ((Number(req.headers.get('content-length')) || 0) > 1_000_000) return err('Corps trop volumineux', 413);
  const body = await req.json<{ schemaVersion?: unknown; batchId?: unknown; entries?: unknown }>().catch(() => null);
  if (!body || body.schemaVersion !== 1 || body.batchId !== batchId || !Array.isArray(body.entries)) return err('Contrat de lot invalide');
  if (body.entries.length < 1 || body.entries.length > MAX_ENTRIES) return err(`Le lot doit contenir de 1 à ${MAX_ENTRIES} entrées`);
  const entries = body.entries as Enrichment[];
  const ids = entries.map((entry) => typeof entry?.id === 'string' ? entry.id : '');
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return err('Identifiants invalides ou dupliqués');
  const payload = JSON.stringify(body);
  const payloadHash = await sha256(payload);
  const existing = await env.DB.prepare('SELECT payload_hash, result FROM vocabulary_enrichment_batches WHERE batch_id = ?').bind(batchId).first<{ payload_hash: string; result: string | null }>();
  if (existing) {
    if (existing.payload_hash !== payloadHash) return err('Ce batchId a déjà été utilisé avec un autre contenu', 409);
    return json(JSON.parse(existing.result ?? '{}'));
  }
  const placeholders = ids.map(() => '?').join(', ');
  const { results: rows } = await env.DB.prepare(`SELECT id, mot, traduction, type, niveau FROM words WHERE id IN (${placeholders})`).bind(...ids).all<SourceRow>();
  const sources = new Map(rows.map((row) => [row.id, row]));
  const validation = entries.flatMap((entry, index) => {
    const source = sources.get(entry.id);
    return source ? validateEntry(entry, source).map((message) => `entries[${index}]: ${message}`) : [`entries[${index}]: mot introuvable`];
  });
  if (validation.length) return json({ error: 'Lot refusé', errors: validation }, 400);
  const now = new Date().toISOString();
  const currentVersions = await env.DB.prepare(`SELECT word_id, version FROM vocabulary_enrichments WHERE word_id IN (${placeholders})`).bind(...ids).all<{ word_id: string; version: number }>();
  const versions = new Map(currentVersions.results.map((row) => [row.word_id, row.version]));
  const statements: D1PreparedStatement[] = [];
  const publishedVersions: Record<string, number> = {};
  entries.forEach((entry) => {
    const version = (versions.get(entry.id) ?? 0) + 1;
    const source = sources.get(entry.id)!;
    const data = JSON.stringify(entry), snapshot = JSON.stringify(source);
    publishedVersions[entry.id] = version;
    statements.push(env.DB.prepare('INSERT INTO vocabulary_enrichment_versions (word_id, version, schema_version, batch_id, data, source_snapshot, published_at) VALUES (?, ?, 1, ?, ?, ?, ?)').bind(entry.id, version, batchId, data, snapshot, now));
    statements.push(env.DB.prepare(`INSERT INTO vocabulary_enrichments (word_id, version, schema_version, batch_id, data, source_snapshot, published_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT(word_id) DO UPDATE SET version=excluded.version, schema_version=excluded.schema_version, batch_id=excluded.batch_id, data=excluded.data, source_snapshot=excluded.source_snapshot, published_at=excluded.published_at, updated_at=excluded.updated_at`).bind(entry.id, version, batchId, data, snapshot, now, now));
  });
  const result = { ok: true, batchId, ids, versions: publishedVersions, publishedAt: now };
  statements.push(env.DB.prepare('INSERT INTO vocabulary_enrichment_batches (batch_id, schema_version, status, entry_ids, payload_hash, result, created_at, published_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)').bind(batchId, 'published', JSON.stringify(ids), payloadHash, JSON.stringify(result), now, now));
  await env.DB.batch(statements);
  return json(result);
}

export async function handleListVocabularyEnrichments(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const url = new URL(req.url), limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
  const { results } = await env.DB.prepare(`SELECT e.word_id, e.version, e.schema_version, e.batch_id, e.data, e.source_snapshot, e.published_at, w.mot, w.traduction, w.type, w.niveau
    FROM vocabulary_enrichments e JOIN words w ON w.id=e.word_id ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<Record<string, unknown>>();
  return json({ items: results.map((row) => ({ ...row, data: JSON.parse(String(row.data)), source_snapshot: JSON.parse(String(row.source_snapshot)) })), count: results.length, limit, offset });
}

export async function handleRollbackVocabularyEntry(req: Request, env: Env, wordId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<{ version?: unknown }>().catch(() => null);
  const targetVersion = Number(body?.version);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) return err('Version cible invalide');
  const target = await env.DB.prepare('SELECT data, source_snapshot, schema_version FROM vocabulary_enrichment_versions WHERE word_id = ? AND version = ?').bind(wordId, targetVersion).first<{ data: string; source_snapshot: string; schema_version: number }>();
  const current = await env.DB.prepare('SELECT version FROM vocabulary_enrichments WHERE word_id = ?').bind(wordId).first<{ version: number }>();
  if (!target || !current) return err('Version introuvable', 404);
  const version = current.version + 1, now = new Date().toISOString(), batchId = `rollback-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO vocabulary_enrichment_versions (word_id, version, schema_version, batch_id, data, source_snapshot, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(wordId, version, target.schema_version, batchId, target.data, target.source_snapshot, now),
    env.DB.prepare('UPDATE vocabulary_enrichments SET version=?, schema_version=?, batch_id=?, data=?, source_snapshot=?, published_at=?, updated_at=? WHERE word_id=?').bind(version, target.schema_version, batchId, target.data, target.source_snapshot, now, now, wordId),
  ]);
  return json({ ok: true, wordId, restoredFromVersion: targetVersion, version, publishedAt: now });
}

/**
 * Environnement de test du Worker, sans Cloudflare :
 * - D1 simulé par une base SQLite en mémoire (node:sqlite) sur laquelle on
 *   applique les vraies migrations du dépôt ;
 * - R2 simulé par une Map ;
 * - Secrets Store simulé.
 * Il sert aux tests de non-régression (LOT 0) : on appelle `worker.fetch`
 * comme le ferait Cloudflare, pour vérifier les contrats utilisés par la
 * PWA et par l'atelier.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import worker from '../../src/index';
import type { Env } from '../../src/types';

export const API_SECRET = 'secret-de-test';
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');

type Param = string | number | bigint | null | Uint8Array;

function toParam(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  return String(value);
}

const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;

class FakeStatement {
  constructor(private db: DatabaseSync, readonly sql: string, private params: Param[] = []) {}

  bind(...values: unknown[]) {
    return new FakeStatement(this.db, this.sql, values.map(toParam));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column ? ((row as Record<string, unknown>)[column] as T) : plain<T>(row);
  }

  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((row) => plain<T>(row));
    return { results: rows, success: true, meta: {} };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  }

  async raw<T>() {
    return this.db.prepare(this.sql).all(...this.params).map((row) => Object.values(row as object) as T);
  }
}

export class FakeD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }
  }

  prepare(sql: string) {
    return new FakeStatement(this.sqlite, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

interface StoredObject {
  data: Uint8Array;
  httpMetadata?: { contentType?: string };
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value && typeof (value as ReadableStream).getReader === 'function') {
    return new Uint8Array(await new Response(value as ReadableStream).arrayBuffer());
  }
  throw new Error('Type de corps R2 non géré dans le test');
}

export class FakeR2 {
  readonly objects = new Map<string, StoredObject>();

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { data: await toBytes(value), httpMetadata: options?.httpMetadata });
    return { key };
  }

  private describe(key: string, stored: StoredObject, data = stored.data) {
    return {
      key,
      size: stored.data.byteLength,
      httpMetadata: stored.httpMetadata ?? {},
      body: new Response(data).body,
      arrayBuffer: async () => data.slice().buffer,
      text: async () => new TextDecoder().decode(data),
      writeHttpMetadata: (headers: Headers) => {
        if (stored.httpMetadata?.contentType) headers.set('Content-Type', stored.httpMetadata.contentType);
      },
    };
  }

  async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const range = options?.range;
    if (!range) return this.describe(key, stored);
    const start = range.suffix !== undefined ? stored.data.byteLength - range.suffix : range.offset ?? 0;
    const end = range.length !== undefined ? start + range.length : stored.data.byteLength;
    return this.describe(key, stored, stored.data.slice(start, end));
  }

  async head(key: string) {
    const stored = this.objects.get(key);
    return stored ? { key, size: stored.data.byteLength, httpMetadata: stored.httpMetadata ?? {} } : null;
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .map(([key, stored]) => ({ key, size: stored.data.byteLength }));
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
}

const secret = (value: string) => ({ get: async () => value });

export function createEnv() {
  const db = new FakeD1();
  const audio = new FakeR2();
  const env = {
    DB: db,
    AUDIO: audio,
    API_SECRET,
    TECHPULSE: { fetch: async () => new Response('{}') },
    OPENAI_API_KEY: secret('cle-openai-test'),
    OPENROUTER_API_KEY: secret('cle-openrouter-test'),
    GEMINI_API_KEY: secret('cle-gemini-test'),
    GROQ_API_KEY_1: secret('cle-groq-test'),
    GROQ_API_KEY_2: secret(''),
    DEEPSEEK_API_KEY: secret('cle-deepseek-test'),
    XAI_API_KEY: secret('cle-xai-test'),
  } as unknown as Env;
  return { env, db, audio };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export async function call(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {},
) {
  const headers = new Headers(init.headers);
  if (init.auth !== false) headers.set('Authorization', `Bearer ${API_SECRET}`);
  let body: BodyInit | undefined;
  if (init.body instanceof Uint8Array || typeof init.body === 'string') body = init.body as BodyInit;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set('Content-Type', 'application/json');
  }
  const request = new Request(`https://worker.test${path}`, { method: init.method ?? 'GET', headers, body });
  return worker.fetch(request, env, ctx);
}

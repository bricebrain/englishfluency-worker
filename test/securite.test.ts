/**
 * Constats de sécurité de l'audit LOT 0 (voir AUDIT_LOT0.md, § Sécurité).
 *
 * Les tests `it.fails` DOCUMENTENT une faille encore présente : ils passent
 * tant que la faille existe. Quand elle sera corrigée, ils échoueront :
 * il faudra alors remplacer `it.fails` par `it`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { call, createEnv } from './support/env';

afterEach(() => vi.unstubAllGlobals());

function espionnerFetch() {
  const appels: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    appels.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return appels;
}

describe('Routes protégées (référence)', () => {
  it.each([
    ['POST', '/content'], ['POST', '/content/audio?key=prepared-content/a.mp3'], ['DELETE', '/content/x'],
    ['POST', '/srs/review'], ['POST', '/srs/known'], ['POST', '/learning/events'], ['POST', '/articles/promote-words'],
  ])('%s %s refuse une requête sans clé', async (method, path) => {
    const { env } = createEnv();
    const response = await call(env, path, { method, auth: false, body: method === 'DELETE' ? undefined : {} });
    expect(response.status).toBe(401);
  });
});

describe('FAILLE — proxy IA sans authentification', () => {
  it.fails('/proxy/deepseek refuse une requête sans clé (et n’appelle pas l’API)', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, '/proxy/deepseek/v1/models', { auth: false });
    expect(appels).toHaveLength(0);
    expect(response.status).toBe(401);
  });

  it.fails('/tts/openai refuse une requête sans clé (et n’appelle pas l’API)', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, '/tts/openai', { method: 'POST', auth: false, body: { text: 'Hello' } });
    expect(appels).toHaveLength(0);
    expect(response.status).toBe(401);
  });

  it('constat actuel : le proxy transmet la requête à DeepSeek sans authentification', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, '/proxy/deepseek/v1/models', { auth: false });
    expect(response.status).toBe(200);
    expect(appels).toEqual(['https://api.deepseek.com/v1/models']);
  });

  it('constat actuel : /tts/openai appelle OpenAI sans authentification', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    await call(env, '/tts/openai', { method: 'POST', auth: false, body: { text: 'Hello' } }).catch(() => undefined);
    expect(appels.some((url) => url.startsWith('https://api.openai.com/'))).toBe(true);
  });
});

describe('FAILLE — lectures de données personnelles sans authentification', () => {
  it.fails('GET /content refuse une requête sans clé', async () => {
    const { env } = createEnv();
    expect((await call(env, '/content?profileId=default', { auth: false })).status).toBe(401);
  });

  it.fails('GET /srs/stats refuse une requête sans clé', async () => {
    const { env } = createEnv();
    expect((await call(env, '/srs/stats?profileId=default', { auth: false })).status).toBe(401);
  });
});

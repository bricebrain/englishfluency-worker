/**
 * Sécurité du Worker (audit LOT 0, convert/AUDIT_LOT0.md § 3).
 *
 * Le proxy IA et les routes TTS exigent le secret depuis le correctif
 * « fix: require auth on AI proxy and TTS routes ».
 *
 * Les tests `it.fails` restants DOCUMENTENT une faille encore présente :
 * ils passent tant qu'elle existe. Une fois corrigée, ils échoueront et il
 * faudra remplacer `it.fails` par `it`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { call, createEnv } from './support/env';

afterEach(() => vi.unstubAllGlobals());

interface AppelSortant { url: string; authorization: string | null }

function espionnerFetch() {
  const appels: AppelSortant[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    appels.push({ url: request.url, authorization: request.headers.get('Authorization') });
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

describe('Proxy IA : authentification obligatoire', () => {
  it.each(['openai', 'openrouter', 'gemini', 'groq', 'deepseek', 'xai'])(
    '/proxy/%s refuse une requête sans clé, sans appeler le fournisseur',
    async (cible) => {
      const { env } = createEnv();
      const appels = espionnerFetch();
      const response = await call(env, `/proxy/${cible}/v1/models`, { auth: false });
      expect(response.status).toBe(401);
      expect(appels).toHaveLength(0);
    },
  );

  it('refuse un mauvais secret', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, '/proxy/deepseek/v1/models', { auth: false, headers: { Authorization: 'Bearer mauvais-secret' } });
    expect(response.status).toBe(401);
    expect(appels).toHaveLength(0);
  });

  it('avec le secret : relaie vers le fournisseur avec SA clé, jamais le secret du Worker', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, '/proxy/deepseek/v1/models');
    expect(response.status).toBe(200);
    expect(appels).toEqual([{ url: 'https://api.deepseek.com/v1/models', authorization: 'Bearer cle-deepseek-test' }]);
  });

  it('avec le secret : Gemini natif reçoit la clé dans l’URL, sans en-tête Authorization', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    await call(env, '/proxy/gemini/v1beta/models');
    expect(appels).toHaveLength(1);
    expect(new URL(appels[0].url).searchParams.get('key')).toBe('cle-gemini-test');
    expect(appels[0].authorization).toBeNull();
  });
});

describe('TTS : authentification obligatoire', () => {
  it.each(['openai', 'gemini', 'groq'])('/tts/%s refuse une requête sans clé, sans appeler le fournisseur', async (fournisseur) => {
    const { env, audio } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, `/tts/${fournisseur}`, { method: 'POST', auth: false, body: { text: 'Hello' } });
    expect(response.status).toBe(401);
    expect(appels).toHaveLength(0);
    expect(audio.objects.size).toBe(0);
  });

  it('avec le secret : /tts/openai appelle OpenAI avec la clé OpenAI', async () => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    await call(env, '/tts/openai', { method: 'POST', body: { text: 'Hello' } }).catch(() => undefined);
    const openai = appels.filter((appel) => appel.url.startsWith('https://api.openai.com/'));
    expect(openai.length).toBeGreaterThan(0);
    expect(openai.every((appel) => appel.authorization === 'Bearer cle-openai-test')).toBe(true);
  });

  it('GET /audio reste public (lecteur audio du navigateur)', async () => {
    const { env, audio } = createEnv();
    await audio.put('tts/openai/abc.mp3', new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'audio/mpeg' } });
    expect((await call(env, '/audio/tts/openai/abc.mp3', { auth: false })).status).toBe(200);
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

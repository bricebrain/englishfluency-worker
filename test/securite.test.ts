/**
 * Sécurité du Worker (audit LOT 0, convert/AUDIT_LOT0.md § 3).
 *
 * Le proxy IA et les routes TTS exigent le secret depuis le correctif
 * « fix: require auth on AI proxy and TTS routes ».
 *
 * Les lectures (GET/HEAD) exigent le secret depuis le correctif
 * « fix: require auth on GET reads », sauf GET / et GET /audio/*.
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

// Toutes les routes GET de src/index.ts (avec des paramètres concrets)
const LECTURES = [
  '/youtube/search?q=x', '/youtube/videos?ids=x', '/assimil/lessons', '/assimil/progress', '/assimil/runpod/status',
  '/assimil/preparation/status', '/assimil/lesson/1', '/assimil/lesson/1/transcription-status', '/profiles',
  '/profile?profileId=default', '/srs/session?profileId=default', '/srs/stats?profileId=default',
  '/srs/triage?profileId=default', '/learning/mission?profileId=default', '/learning/insights?profileId=default',
  '/srs/progress?profileId=default', '/content?profileId=default', '/content/x', '/dictation?profileId=default',
  '/lingvist/session?profileId=default', '/lingvist/cards?profileId=default', '/lingvist/card/x',
  '/calibration?profileId=default', '/podcasts/daily', '/lessons/channel', '/admin/channels', '/articles',
  '/reading-library/items', '/reading-library/items/x/segments', '/podcast-feeds', '/podcast-feeds/recommend',
  '/podcast-feeds/x/episodes', '/podcast-feeds/episodes/x/lesson', '/podcast-feeds/episodes/x/transcription-status',
  '/podcast-feeds/episodes/x', '/srt/sources', '/srt/r2-objects', '/srt/sources/x/episodes', '/srt/episodes/x/scenes',
  '/words/count', '/words/sync', '/words/random', '/words/grammar-seed', '/words', '/words/x',
];

describe('Lectures : authentification obligatoire', () => {
  it('la liste couvre toutes les routes GET de src/index.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const routesGet = source.split('\n').filter((ligne) => /method === 'GET'\s*&&\s*path/.test(ligne)).length;
    // + la route publique « / » et « /audio/ », hors liste
    expect(LECTURES.length + 2).toBe(routesGet);
  });

  it.each(LECTURES)('GET %s refuse une requête sans clé', async (chemin) => {
    const { env } = createEnv();
    const appels = espionnerFetch();
    const response = await call(env, chemin, { auth: false });
    expect(response.status).toBe(401);
    expect(appels).toHaveLength(0);
  });

  it('HEAD est soumis à la même règle', async () => {
    const { env } = createEnv();
    expect((await call(env, '/content?profileId=default', { method: 'HEAD', auth: false })).status).toBe(401);
  });

  it('GET / (santé) reste public', async () => {
    const { env } = createEnv();
    expect((await call(env, '/', { auth: false })).status).toBe(200);
  });

  it('avec le secret, les lectures fonctionnent', async () => {
    const { env } = createEnv();
    expect((await call(env, '/content?profileId=default')).status).toBe(200);
    expect((await call(env, '/srs/stats?profileId=default')).status).toBe(200);
  });
});

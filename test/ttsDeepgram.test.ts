import { afterEach, describe, expect, it, vi } from 'vitest';

import { call, createEnv } from './support/env';

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);

function deepgramEnv() {
  const { env, audio } = createEnv();
  return { env: Object.assign(env, { DEEPGRAM_API_KEY: 'cle-deepgram-test' }), audio };
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /tts/deepgram', () => {
  it('refuse sans authentification', async () => {
    const { env } = deepgramEnv();
    expect((await call(env, '/tts/deepgram', { method: 'POST', auth: false, body: { text: 'range' } })).status).toBe(401);
  });

  it('refuse un texte vide ou trop long', async () => {
    const { env } = deepgramEnv();
    expect((await call(env, '/tts/deepgram', { method: 'POST', body: { text: '  ' } })).status).toBe(400);
    expect((await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'a'.repeat(1801) } })).status).toBe(400);
  });

  it('génère avec la voix britannique Draco par défaut, met en cache R2, puis ne repaie pas', async () => {
    const { env } = deepgramEnv();
    const fetchSpy = vi.fn(async () => new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } }));
    vi.stubGlobal('fetch', fetchSpy);

    const first = await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'Prices range from 10 to 20 euros.' } });
    const firstBody = await first.json() as { audioUrl: string; cached: boolean };
    expect(firstBody.cached).toBe(false);
    expect(firstBody.audioUrl).toMatch(/^\/audio\/tts\/deepgram\/aura-2-draco-en\/[0-9a-f]{40}\.mp3$/);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-draco-en&encoding=mp3');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token cle-deepgram-test');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'Prices range from 10 to 20 euros.' });

    // Même texte (espaces normalisés) : servi depuis le cache, sans appel Deepgram.
    const second = await call(env, '/tts/deepgram', { method: 'POST', body: { text: ' Prices  range from 10 to 20 euros. ' } });
    expect(await second.json()).toEqual({ audioUrl: firstBody.audioUrl, cached: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Le fichier est servi par /audio.
    const served = await call(env, firstBody.audioUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get('Content-Type')).toBe('audio/mpeg');
  });

  it('n’accepte qu’une voix de la liste et ignore les autres', async () => {
    const { env } = deepgramEnv();
    const fetchSpy = vi.fn(async () => new Response(mp3));
    vi.stubGlobal('fetch', fetchSpy);
    await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'hello', voice: 'aura-2-pandora-en' } });
    await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'hello', voice: 'voix-inconnue' } });
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain('model=aura-2-pandora-en');
    expect(String((fetchSpy.mock.calls[1] as unknown[])[0])).toContain('model=aura-2-draco-en');
  });

  it('renvoie 502 sans rien mettre en cache si Deepgram échoue', async () => {
    const { env } = deepgramEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 402 })));
    const response = await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'hello' } });
    expect(response.status).toBe(502);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mp3)));
    expect(await (await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'hello' } })).json()).toMatchObject({ cached: false });
  });

  it('renvoie 503 si la clé Deepgram manque', async () => {
    const { env } = createEnv();
    expect((await call(env, '/tts/deepgram', { method: 'POST', body: { text: 'hello' } })).status).toBe(503);
  });
});

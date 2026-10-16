/**
 * Non-régression — upload d'audio par l'atelier et lecture par la PWA.
 * Le comportement de GET /audio est figé AVANT l'ajout des requêtes Range
 * (lot 1) : une requête sans Range doit continuer à fonctionner ainsi.
 */
import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

const MP3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(2045).fill(7)]);

describe('POST /content/audio', () => {
  it('refuse sans clé', async () => {
    const { env } = createEnv();
    const response = await call(env, '/content/audio?key=prepared-content/a.mp3', { method: 'POST', body: MP3, auth: false });
    expect(response.status).toBe(401);
  });

  it.each(['../secret.mp3', 'prepared-content/../x.mp3', '/abs.mp3', ''])('refuse la clé invalide « %s »', async (key) => {
    const { env } = createEnv();
    const response = await call(env, `/content/audio?key=${encodeURIComponent(key)}`, { method: 'POST', body: MP3 });
    expect(response.status).toBe(400);
  });

  it('refuse un corps vide', async () => {
    const { env } = createEnv();
    const response = await call(env, '/content/audio?key=prepared-content/a.mp3', { method: 'POST', body: '' });
    expect(response.status).toBe(400);
  });

  it('stocke le MP3 dans R2 avec le type audio/mpeg', async () => {
    const { env, audio } = createEnv();
    const response = await call(env, '/content/audio?key=prepared-content/a-en.mp3', { method: 'POST', body: MP3 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, key: 'prepared-content/a-en.mp3', size: MP3.byteLength });
    expect(audio.objects.get('prepared-content/a-en.mp3')?.httpMetadata?.contentType).toBe('audio/mpeg');
  });
});

describe('GET /audio/<clé> (sans Range)', () => {
  it('renvoie le fichier complet avec son type, en accès public', async () => {
    const { env } = createEnv();
    await call(env, '/content/audio?key=prepared-content/a.mp3', { method: 'POST', body: MP3 });
    const response = await call(env, '/audio/prepared-content/a.mp3', { auth: false });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3);
  });

  it('renvoie 404 pour un audio absent', async () => {
    const { env } = createEnv();
    expect((await call(env, '/audio/prepared-content/absent.mp3', { auth: false })).status).toBe(404);
  });
});

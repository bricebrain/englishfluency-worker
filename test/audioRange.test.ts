/**
 * LOT 1 — requêtes Range sur GET /audio/<clé> (v1.2 § 8.1), HEAD et cache.
 */
import { describe, expect, it } from 'vitest';

import { parseRange } from '../src/tts';
import { call, createEnv } from './support/env';

const SIZE = 1000;
const DATA = Uint8Array.from({ length: SIZE }, (_, i) => i % 256);
const KEY = 'prepared-content/cyber-faithful-1a2b3c4d.mp3';

async function setup(key = KEY) {
  const { env, audio } = createEnv();
  await audio.put(key, DATA, { httpMetadata: { contentType: 'audio/mpeg' } });
  return env;
}

const get = (env: Parameters<typeof call>[0], range?: string, method = 'GET', key = KEY) =>
  call(env, `/audio/${key}`, { auth: false, method, headers: range ? { Range: range } : {} });

describe('parseRange', () => {
  it.each([
    ['bytes=0-99', { offset: 0, length: 100 }],
    ['bytes=900-', { offset: 900, length: 100 }],
    ['bytes=-100', { offset: 900, length: 100 }],
    ['bytes=-5000', { offset: 0, length: 1000 }],
    ['bytes=990-5000', { offset: 990, length: 10 }],
    ['bytes=999-999', { offset: 999, length: 1 }],
  ])('%s', (header, expected) => {
    expect(parseRange(header, SIZE)).toEqual(expected);
  });

  it.each(['bytes=1000-', 'bytes=1000-1001', 'bytes=50-10', 'bytes=-0'])('%s est insatisfiable', (header) => {
    expect(parseRange(header, SIZE)).toBe('unsatisfiable');
  });

  it.each([null, '', 'items=0-1', 'bytes=0-1,5-6', 'bytes=-', 'bytes=a-b'])('« %s » est ignoré (réponse complète)', (header) => {
    expect(parseRange(header, SIZE)).toBeNull();
  });
});

describe('GET /audio avec Range', () => {
  it('bytes=a-b : 206, en-têtes justes, octets exacts (fin incluse)', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=10-19');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 10-19/1000');
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(DATA.slice(10, 20));
  });

  it('bytes=a- : jusqu’à la fin', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=995-');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 995-999/1000');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(DATA.slice(995));
  });

  it('bytes=-n : les n derniers octets', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=-4');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe('bytes 996-999/1000');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(DATA.slice(996));
  });

  it('bytes=0-1 (première requête de Safari)', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=0-1');
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Length')).toBe('2');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(DATA.slice(0, 2));
  });

  it('plage invalide : 416 avec Content-Range bytes */taille', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=2000-');
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */1000');
  });

  it('sans Range : 200 complet, comme avant, avec Accept-Ranges et Content-Length', async () => {
    const env = await setup();
    const response = await get(env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(response.headers.get('Content-Length')).toBe('1000');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(DATA);
  });

  it('HEAD : en-têtes sans corps, avec ou sans Range', async () => {
    const env = await setup();
    const full = await get(env, undefined, 'HEAD');
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('1000');
    expect(await full.text()).toBe('');
    const partial = await get(env, 'bytes=0-9', 'HEAD');
    expect(partial.status).toBe(206);
    expect(partial.headers.get('Content-Range')).toBe('bytes 0-9/1000');
  });

  it('HEAD sur un audio absent : 404', async () => {
    const env = await setup();
    expect((await get(env, undefined, 'HEAD', 'prepared-content/absent.mp3')).status).toBe(404);
  });

  it('expose Content-Range au JavaScript (CORS)', async () => {
    const env = await setup();
    const response = await get(env, 'bytes=0-1');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
  });
});

describe('Cache-Control', () => {
  it('immutable pour une clé versionnée et le cache TTS', async () => {
    const env = await setup();
    expect((await get(env)).headers.get('Cache-Control')).toContain('immutable');
    const tts = await setup('tts/openai/abc.mp3');
    expect((await get(tts, undefined, 'GET', 'tts/openai/abc.mp3')).headers.get('Cache-Control')).toContain('immutable');
  });

  it.each(['prepared-content/cyber.mp3', 'prepared-content/cyber-en.mp3'])('jamais immutable pour l’ancienne clé fixe %s', async (key) => {
    const env = await setup(key);
    const response = await get(env, undefined, 'GET', key);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).not.toContain('immutable');
  });
});

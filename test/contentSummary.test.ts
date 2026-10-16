/**
 * LOT 1 — liste allégée (GET /content?view=summary) et détail (GET /content/:id).
 */
import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

const longText = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(' ');

function payloadV2(id: string, profileId = 'default') {
  const segments = Array.from({ length: 120 }, (_, i) => ({
    id: `s${String(i + 1).padStart(3, '0')}`, en: longText(6), fr: longText(6), startMs: i * 1000, endMs: i * 1000 + 900,
  }));
  return {
    profileId, id, type: 'podcast', title: `Titre ${id}`, level: 'B1', topic: 'tech',
    body: longText(200),
    audioR2Key: `prepared-content/${id}-faithful-1a2b3c4d.mp3`,
    metadata: {
      schemaVersion: 2, sourceType: 'youtube', sourceUrl: 'https://youtu.be/x', sourceLanguage: 'en',
      audioOrigin: 'original', contentRevision: 'abc123', durationLabel: '12 min', durationSeconds: 720,
      transcriptText: longText(200), textEn: longText(200), textFr: longText(200),
      segments,
      chunks: [{ id: 'c001', expression: 'figure out' }, { id: 'c002', expression: 'carry on' }],
      grammarPoints: [{ id: 'g001' }],
    },
  };
}

async function publish(env: Parameters<typeof call>[0], body: unknown) {
  expect((await call(env, '/content', { method: 'POST', body })).status).toBe(200);
}

describe('GET /content?view=summary', () => {
  it('ne renvoie ni segments ni textes longs, mais des compteurs', async () => {
    const { env } = createEnv();
    await publish(env, payloadV2('cyber'));
    const response = await call(env, '/content?profileId=default&view=summary');
    const text = await response.text();
    const data = JSON.parse(text) as { items: Array<Record<string, any>> };
    const item = data.items[0];
    expect(item.metadata).toMatchObject({
      schemaVersion: 2, sourceType: 'youtube', sourceUrl: 'https://youtu.be/x', sourceLanguage: 'en',
      audioOrigin: 'original', contentRevision: 'abc123', durationLabel: '12 min', durationSeconds: 720,
    });
    expect(item.metadata.segments).toBeUndefined();
    expect(item.metadata.chunks).toBeUndefined();
    for (const key of ['textEn', 'textFr', 'transcriptText']) {
      expect(item.metadata[key].length).toBeLessThanOrEqual(501);
      expect(item.metadata[key].endsWith('…')).toBe(true);
    }
    expect(item.summary).toEqual({
      segmentCount: 120, chunkCount: 2, grammarPointCount: 1, hasTimings: true, bodyTruncated: true,
      truncatedKeys: ['transcriptText', 'textEn', 'textFr'],
    });
    expect(item.body.length).toBeLessThanOrEqual(601);
    expect(item.body.endsWith('…')).toBe(true);
    expect(item).toMatchObject({ id: 'cyber', title: 'Titre cyber', audioR2Key: 'prepared-content/cyber-faithful-1a2b3c4d.mp3' });
    // La liste complète pèse beaucoup plus lourd
    const full = await (await call(env, '/content?profileId=default')).text();
    expect(text.length * 10).toBeLessThan(full.length);
  });

  it('hasTimings est faux pour un ancien contenu sans timings', async () => {
    const { env } = createEnv();
    const ancien = payloadV2('ancien');
    ancien.metadata.segments = ancien.metadata.segments.map((s) => ({ ...s, startMs: null, endMs: null })) as never;
    await publish(env, ancien);
    const { items } = await (await call(env, '/content?profileId=default&view=summary')).json() as { items: Array<Record<string, any>> };
    expect(items[0].summary.hasTimings).toBe(false);
  });

  it('ne tronque jamais un corps JSON structuré (leçons partagées)', async () => {
    const { env } = createEnv();
    const body = JSON.stringify({ titleEn: 'Lesson', steps: Array.from({ length: 40 }, () => ({ bodyFr: longText(3) })) });
    await publish(env, { profileId: '__global__', id: 'lecon', type: 'course', title: 'Leçon', body, metadata: { language: 'en' } });
    const { items } = await (await call(env, '/content?profileId=__global__&view=summary')).json() as { items: Array<Record<string, any>> };
    expect(items[0].body).toBe(body);
    expect(items[0].summary).toMatchObject({ segmentCount: 0, bodyTruncated: false, hasTimings: false });
  });

  it('sans view, la réponse reste complète (rétrocompatibilité)', async () => {
    const { env } = createEnv();
    const envoye = payloadV2('cyber');
    await publish(env, envoye);
    const { items } = await (await call(env, '/content?profileId=default')).json() as { items: Array<Record<string, any>> };
    expect(items[0].metadata).toEqual(envoye.metadata);
    expect(items[0].summary).toBeUndefined();
  });

  it('exige le secret', async () => {
    const { env } = createEnv();
    expect((await call(env, '/content?profileId=default&view=summary', { auth: false })).status).toBe(401);
  });
});

describe('GET /content/:id', () => {
  it('renvoie le contenu complet', async () => {
    const { env } = createEnv();
    const envoye = payloadV2('cyber');
    await publish(env, envoye);
    const response = await call(env, '/content/cyber');
    expect(response.status).toBe(200);
    const item = await response.json() as Record<string, any>;
    expect(item).toMatchObject({ id: 'cyber', body: envoye.body, isFavorite: false });
    expect(item.metadata).toEqual(envoye.metadata);
  });

  it('lit aussi un contenu __global__', async () => {
    const { env } = createEnv();
    await publish(env, payloadV2('partage', '__global__'));
    expect((await call(env, '/content/partage')).status).toBe(200);
  });

  it('404 si absent, 401 sans secret', async () => {
    const { env } = createEnv();
    expect((await call(env, '/content/absent')).status).toBe(404);
    expect((await call(env, '/content/absent', { auth: false })).status).toBe(401);
  });
});

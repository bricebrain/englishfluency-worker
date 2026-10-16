/**
 * Non-régression — contenus préparés (utilisés par l'atelier `convert/` et
 * la page Scripts & audios de la PWA).
 */
import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

// Forme exacte publiée par l'atelier (convert/pipeline.py, payload_distant)
function payloadAtelier(id: string, extra: Record<string, unknown> = {}) {
  return {
    profileId: 'default', id, type: 'podcast', title: `Titre ${id}`, level: 'B1', topic: 'tech',
    body: 'Hello everyone.\nWe need to figure it out.',
    audioR2Key: `prepared-content/${id}.mp3`,
    metadata: {
      sourceType: 'youtube', sourceUrl: 'https://youtu.be/x', audioLanguage: 'en', transcriptLanguage: 'en',
      transcriptText: 'Hello everyone.', schemaVersion: 2, sourceLanguage: 'en', learningLanguage: 'en',
      targetLocale: 'en-GB', audioOrigin: 'original', contentRevision: 'abc123',
      textEn: 'Hello everyone.\nWe need to figure it out.', textFr: 'Bonjour à tous.\nNous devons comprendre.',
      segments: [{ id: 's001', en: 'Hello everyone.', fr: 'Bonjour à tous.', startMs: null, endMs: null }],
      chunks: [{ id: 'c001', expression: 'figure out', meaningFr: 'comprendre', level: 'B1', type: 'phrasal_verb', sourceSegmentId: 's001' }],
      grammarPoints: [], durationSeconds: 75, durationLabel: '1 min',
    },
    ...extra,
  };
}

async function lister(env: Parameters<typeof call>[0], profileId = 'default') {
  const response = await call(env, `/content?profileId=${profileId}&limit=100`);
  expect(response.status).toBe(200);
  return (await response.json()) as { items: Array<Record<string, unknown>>; count: number };
}

describe('POST /content', () => {
  it('refuse sans clé', async () => {
    const { env } = createEnv();
    const response = await call(env, '/content', { method: 'POST', body: payloadAtelier('a'), auth: false });
    expect(response.status).toBe(401);
  });

  it('refuse un type inconnu', async () => {
    const { env } = createEnv();
    const response = await call(env, '/content', { method: 'POST', body: payloadAtelier('a', { type: 'video' }) });
    expect(response.status).toBe(400);
  });

  it('conserve intégralement la metadata de l’atelier (aller-retour)', async () => {
    const { env } = createEnv();
    const envoye = payloadAtelier('cyber');
    expect((await call(env, '/content', { method: 'POST', body: envoye })).status).toBe(200);
    const { items } = await lister(env);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'cyber', type: 'podcast', title: 'Titre cyber', level: 'B1', topic: 'tech',
      body: envoye.body, audioR2Key: 'prepared-content/cyber.mp3', isFavorite: false,
    });
    expect(items[0].metadata).toEqual(envoye.metadata);
  });

  it('republier le même id met à jour sans dupliquer, y compris level et topic', async () => {
    const { env } = createEnv();
    await call(env, '/content', { method: 'POST', body: payloadAtelier('x') });
    await call(env, '/content', { method: 'POST', body: payloadAtelier('x', { title: 'Nouveau', level: 'B2', topic: 'culture' }) });
    const { items } = await lister(env);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Nouveau', level: 'B2', topic: 'culture' });
  });

  it('une mise à jour sans level/topic conserve les valeurs existantes', async () => {
    const { env } = createEnv();
    await call(env, '/content', { method: 'POST', body: payloadAtelier('x', { level: 'B2', topic: 'culture' }) });
    const sansNiveau = payloadAtelier('x') as Record<string, unknown>;
    delete sansNiveau.level;
    delete sansNiveau.topic;
    await call(env, '/content', { method: 'POST', body: sansNiveau });
    const { items } = await lister(env);
    expect(items[0]).toMatchObject({ level: 'B2', topic: 'culture' });
  });

  it('à 50 contenus : une republication ne supprime rien, une création évince le plus ancien', async () => {
    const { env, db } = createEnv();
    for (let i = 0; i < 50; i += 1) {
      db.sqlite.prepare(
        "INSERT INTO content (id, profile_id, type, body, created_at) VALUES (?, 'default', 'podcast', '', ?)",
      ).run(`c${String(i).padStart(2, '0')}`, `2026-01-01 00:00:${String(i).padStart(2, '0')}`);
    }
    await call(env, '/content', { method: 'POST', body: payloadAtelier('c10') });
    expect((await lister(env)).count).toBe(50);
    expect((await lister(env)).items.some((item) => item.id === 'c00')).toBe(true);

    await call(env, '/content', { method: 'POST', body: payloadAtelier('nouveau') });
    const apres = await lister(env);
    expect(apres.count).toBe(50);
    expect(apres.items.some((item) => item.id === 'c00')).toBe(false);
    expect(apres.items.some((item) => item.id === 'nouveau')).toBe(true);
  });

  it('isole les contenus par profil', async () => {
    const { env } = createEnv();
    await call(env, '/content', { method: 'POST', body: payloadAtelier('a') });
    await call(env, '/content', { method: 'POST', body: { ...payloadAtelier('b'), profileId: '__global__' } });
    expect((await lister(env, 'default')).items.map((item) => item.id)).toEqual(['a']);
    expect((await lister(env, '__global__')).items.map((item) => item.id)).toEqual(['b']);
  });
});

describe('PATCH et DELETE /content/:id', () => {
  it('bascule le favori', async () => {
    const { env } = createEnv();
    await call(env, '/content', { method: 'POST', body: payloadAtelier('a') });
    expect((await call(env, '/content/a', { method: 'PATCH', body: { isFavorite: true } })).status).toBe(200);
    expect((await lister(env)).items[0].isFavorite).toBe(true);
  });

  // LOT 1 : l'audio de l'atelier n'est plus supprimé immédiatement ; sa
  // référence est retirée et la tâche de nuit le supprime plus tard s'il
  // n'est plus utilisé (test/audioReferences.test.ts).
  it('supprime le contenu et retire son audio R2 (suppression différée)', async () => {
    const { env, audio, db } = createEnv();
    await audio.put('prepared-content/a.mp3', new Uint8Array([1, 2, 3]));
    await call(env, '/content', { method: 'POST', body: payloadAtelier('a') });
    expect((await call(env, '/content/a', { method: 'DELETE' })).status).toBe(200);
    expect((await lister(env)).count).toBe(0);
    expect(audio.objects.has('prepared-content/a.mp3')).toBe(true);
    const ref = await db.prepare("SELECT state FROM audio_references WHERE key = 'prepared-content/a.mp3'").first<{ state: string }>();
    expect(ref?.state).toBe('retired');
  });

  it('refuse la suppression sans clé', async () => {
    const { env } = createEnv();
    await call(env, '/content', { method: 'POST', body: payloadAtelier('a') });
    expect((await call(env, '/content/a', { method: 'DELETE', auth: false })).status).toBe(401);
    expect((await lister(env)).count).toBe(1);
  });
});

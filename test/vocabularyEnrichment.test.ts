import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

function firstWord(db: ReturnType<typeof createEnv>['db']) {
  return db.sqlite.prepare('SELECT id, mot, traduction, type, niveau FROM words ORDER BY id LIMIT 1').get() as {
    id: string; mot: string; traduction: string | null; type: string; niveau: string;
  };
}

function entry(word: ReturnType<typeof firstWord>, translation = 'traduction enrichie') {
  return {
    id: word.id,
    originalWord: word.mot,
    originalTranslation: word.traduction ?? '',
    originalType: word.type,
    lemma: word.mot,
    displayForm: word.type === 'verb' ? `to ${word.mot}` : word.mot,
    partOfSpeech: ['noun','verb','adjective','adverb','preposition'].includes(word.type) ? word.type : 'other',
    primaryTranslation: translation,
    translationStatus: 'incomplete',
    reviewRequired: false,
    reviewNote: null,
    senses: [{
      senseKey: 'main', partOfSpeech: ['noun','verb','adjective','adverb','preposition'].includes(word.type) ? word.type : 'other',
      translation, exampleEn: `A short example with ${word.mot}.`, exampleFr: 'Un exemple court.',
    }],
    collocations: [{ en: 'not at all', fr: 'pas du tout', kind: 'expression', senseKey: 'main' }],
  };
}

describe('enrichissements versionnés du vocabulaire', () => {
  it('refuse une publication non authentifiée', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db), batchId = 'batch-auth';
    const response = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, {
      method: 'POST', auth: false, body: { schemaVersion: 1, batchId, entries: [entry(word)] },
    });
    expect(response.status).toBe(401);
  });

  it('publie sans modifier le mot source et rejoue le même lot idempotemment', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db), batchId = 'batch-publish';
    const payload = { schemaVersion: 1, batchId, entries: [entry(word)] };
    const first = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, { method: 'POST', body: payload });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, batchId, ids: [word.id], versions: { [word.id]: 1 } });
    const replay = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, { method: 'POST', body: payload });
    expect(replay.status).toBe(200);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM vocabulary_enrichment_versions').get()).toMatchObject({ count: 1 });
    expect(db.sqlite.prepare('SELECT mot, traduction FROM words WHERE id = ?').get(word.id)).toMatchObject({ mot: word.mot, traduction: word.traduction });
  });

  it('refuse une altération de la donnée originale', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db), batchId = 'batch-source';
    const changed = { ...entry(word), originalWord: 'autre mot' };
    const response = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, {
      method: 'POST', body: { schemaVersion: 1, batchId, entries: [changed] },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Lot refusé' });
  });

  it('accepte tout type grammatical non vide pour l’entrée et ses sens', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db), batchId = 'batch-conjunction';
    const conjunction = {
      ...entry(word, 'bien que'),
      partOfSpeech: 'subordinating_conjunction',
      senses: [{
        senseKey: 'main', partOfSpeech: 'discourse_marker', translation: 'bien que',
        exampleEn: 'Although it was late, we continued.',
        exampleFr: 'Bien qu’il soit tard, nous avons continué.',
      }],
      collocations: [],
    };
    const response = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, {
      method: 'POST', body: { schemaVersion: 1, batchId, entries: [conjunction] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, batchId, ids: [word.id] });
  });

  it('crée une nouvelle version et permet un rollback versionné', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db);
    for (const [batchId, translation] of [['batch-v1','première'],['batch-v2','seconde']]) {
      const response = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, {
        method: 'POST', body: { schemaVersion: 1, batchId, entries: [entry(word, translation)] },
      });
      expect(response.status).toBe(200);
    }
    const rollback = await call(env, `/admin/vocabulary/entries/${word.id}/rollback`, {
      method: 'POST', body: { version: 1 },
    });
    expect(await rollback.json()).toMatchObject({ ok: true, restoredFromVersion: 1, version: 3 });
    const current = db.sqlite.prepare('SELECT version, data FROM vocabulary_enrichments WHERE word_id = ?').get(word.id) as { version: number; data: string };
    expect(current.version).toBe(3);
    expect(JSON.parse(current.data).primaryTranslation).toBe('première');
  });
});

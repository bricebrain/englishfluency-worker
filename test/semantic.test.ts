import { describe, expect, it } from 'vitest';

import { contentPassages, splitSentences } from '../src/semantic';
import { call, createEnv } from './support/env';

/** Vecteur « sac de mots » déterministe : assez pour tester le classement. */
function fakeEmbedding(text: string): number[] {
  const vector = new Array(32).fill(0);
  for (const word of text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? []) {
    let hash = 0;
    for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % 32] += 1;
  }
  return vector;
}

function cosine(left: number[], right: number[]) {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const norm = Math.sqrt(left.reduce((s, v) => s + v * v, 0) * right.reduce((s, v) => s + v * v, 0)) || 1;
  return dot / norm;
}

function semanticEnv() {
  const created = createEnv();
  const store = new Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>();
  let embeddedTexts = 0;
  const env = Object.assign(created.env, {
    AI: {
      run: async (_model: string, input: { text: string[] }) => {
        embeddedTexts += input.text.length;
        return { data: input.text.map(fakeEmbedding), shape: [input.text.length, 32] };
      },
    },
    VECTORIZE: {
      upsert: async (vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) => {
        vectors.forEach((vector) => store.set(vector.id, vector));
        return { mutationId: 'm' };
      },
      deleteByIds: async (ids: string[]) => { ids.forEach((id) => store.delete(id)); return { mutationId: 'd' }; },
      query: async (vector: number[], options: { topK: number; filter?: { source?: string } }) => ({
        matches: [...store.values()]
          .filter((item) => !options.filter?.source || item.metadata.source === options.filter.source)
          .map((item) => ({ id: item.id, score: cosine(vector, item.values), metadata: item.metadata }))
          .sort((a, b) => b.score - a.score)
          .slice(0, options.topK),
        count: 0,
      }),
    },
  });
  return { ...created, env, store, embedded: () => embeddedTexts };
}

function seedReading(db: ReturnType<typeof createEnv>['db']) {
  db.sqlite.exec(`
    INSERT INTO reading_library_sources (id, title, provider, url) VALUES ('src', 'Source', 'test', 'https://example.test/rss');
    INSERT INTO reading_library_items (id, source_id, title, url, raw_text, category, level) VALUES ('item-money', 'src', 'Saving money', 'https://example.test/a', 'raw', 'finance', 'B1');
    INSERT INTO reading_library_segments (id, item_id, segment_index, title, text, summary_fr, level)
      VALUES ('seg-money', 'item-money', 0, 'Budget', 'Prices range from ten to twenty euros. Saving money is hard when prices rise.', 'Économiser', 'B1'),
             ('seg-sport', 'item-money', 1, 'Sport', 'The football team trained every morning before the match.', 'Football', 'B1');
  `);
}

describe('découpage des passages', () => {
  it('découpe des phrases anglaises', () => {
    expect(splitSentences('Hello there. How are you? I am fine!')).toEqual(['Hello there.', 'How are you?', 'I am fine!']);
  });

  it('regroupe les segments bilingues par trois', () => {
    const segments = Array.from({ length: 4 }, (_, index) => ({ id: `s${index}`, en: `Sentence ${index}.`, fr: `Phrase ${index}.` }));
    const passages = contentPassages({ id: 'c1', title: 'Titre', level: 'B1', body: '', metadata: JSON.stringify({ segments }) });
    expect(passages.map((passage) => passage.refId)).toEqual(['c1#0', 'c1#3']);
    expect(passages[0]).toMatchObject({ text: 'Sentence 0. Sentence 1. Sentence 2.', textFr: 'Phrase 0. Phrase 1. Phrase 2.' });
  });
});

describe('indexation et recherche par le sens', () => {
  it('indexe les passages une seule fois, puis retrouve le plus proche', async () => {
    const { env, db, store, embedded } = semanticEnv();
    seedReading(db);

    const first = await call(env, '/admin/semantic/index', { method: 'POST' });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { indexed: number };
    expect(firstBody.indexed).toBeGreaterThanOrEqual(2);
    const embeddedAfterFirst = embedded();

    // Relancer n'encode rien de nouveau.
    expect(await (await call(env, '/admin/semantic/index', { method: 'POST' })).json()).toMatchObject({ indexed: 0 });
    expect(embedded()).toBe(embeddedAfterFirst);
    expect([...store.keys()].every((id) => id.length <= 64)).toBe(true);

    const search = await call(env, '/search/semantic?q=saving%20money%20prices&limit=1');
    const { results } = await search.json() as { results: { refId: string; source: string; title: string }[] };
    expect(results[0]).toMatchObject({ refId: 'seg-money', source: 'reading', title: 'Saving money — Budget' });
  });

  it('retire de l’index les passages supprimés', async () => {
    const { env, db, store } = semanticEnv();
    seedReading(db);
    await call(env, '/admin/semantic/index', { method: 'POST' });
    const before = store.size;
    db.sqlite.exec(`DELETE FROM reading_library_segments WHERE id = 'seg-sport'`);
    expect(await (await call(env, '/admin/semantic/index', { method: 'POST' })).json()).toMatchObject({ purged: 1 });
    expect(store.size).toBe(before - 1);
  });

  it('masque puis purge les anciens vecteurs de la bibliothèque SRT', async () => {
    const { env, db, store } = semanticEnv();
    const vectorId = 'legacy-srt-vector';
    store.set(vectorId, {
      id: vectorId,
      values: fakeEmbedding('Where are you going?'),
      metadata: {
        source: 'srt',
        refId: 'scene-1',
        parentId: 'episode-1',
        title: 'Ancienne série',
        text: 'Where are you going?',
      },
    });
    db.sqlite.prepare(`
      INSERT INTO semantic_index (vector_id, source, ref_id, parent_id, text_hash)
      VALUES (?, 'srt', 'scene-1', 'episode-1', 'legacy')
    `).run(vectorId);

    const search = await (await call(env, '/search/semantic?q=where')).json() as { results: unknown[] };
    expect(search.results).toEqual([]);
    expect(await (await call(env, '/admin/semantic/index', { method: 'POST' })).json()).toMatchObject({ purged: 1 });
    expect(store.has(vectorId)).toBe(false);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM semantic_index WHERE vector_id = ?').get(vectorId))
      .toMatchObject({ count: 0 });
  });

  it('refuse l’indexation sans authentification et une requête trop courte', async () => {
    const { env } = semanticEnv();
    expect((await call(env, '/admin/semantic/index', { method: 'POST', auth: false })).status).toBe(401);
    expect((await call(env, '/search/semantic?q=a')).status).toBe(400);
  });
});

describe('contextes d’un mot dans les contenus', () => {
  it('renvoie les phrases qui contiennent le mot, y compris fléchi', async () => {
    const { env, db } = semanticEnv();
    seedReading(db);
    const response = await call(env, '/search/word-contexts?word=range&limit=3');
    const { contexts } = await response.json() as { contexts: { sentence: string; source: string; title: string }[] };
    expect(contexts).toEqual([{ source: 'reading', parentId: 'item-money', title: 'Saving money', sentence: 'Prices range from ten to twenty euros.' }]);
    const trained = await (await call(env, '/search/word-contexts?word=train')).json() as { contexts: { sentence: string }[] };
    expect(trained.contexts[0]?.sentence).toContain('trained');
  });

  it('ne confond pas un mot avec un autre qui le contient', async () => {
    const { env, db } = semanticEnv();
    seedReading(db);
    const { contexts } = await (await call(env, '/search/word-contexts?word=rang')).json() as { contexts: unknown[] };
    expect(contexts).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { regenerateLingvistCards } from '../src/nightlyAi';
import { toVocabularyEnrichmentDto } from '../src/vocabularyEnrichmentMapper';
import { call, createEnv } from './support/env';

type Db = ReturnType<typeof createEnv>['db'];
type SourceWord = { id: string; mot: string; traduction: string | null; type: string; niveau: string };
type ApiWord = { id: string; mot: string; traduction: string | null; enrichment?: Record<string, unknown> | null } & Record<string, unknown>;

function words(db: Db, limit = 50) {
  return db.sqlite.prepare('SELECT id, mot, traduction, type, niveau FROM words ORDER BY id LIMIT ?').all(limit) as SourceWord[];
}

function wordsById(db: Db, ids: string[]) {
  const placeholders = ids.map(() => '?').join(', ');
  return db.sqlite.prepare(`SELECT id, mot, traduction, type, niveau FROM words WHERE id IN (${placeholders})`).all(...ids) as SourceWord[];
}

const MODALS = ['can', 'could', 'may', 'might', 'must', 'shall', 'should', 'will', 'would'];
const displayFormOf = (mot: string) => (MODALS.includes(mot.toLowerCase()) ? mot : `to ${mot}`);

function entry(word: SourceWord) {
  return {
    id: word.id,
    originalWord: word.mot,
    originalTranslation: word.traduction ?? '',
    originalType: word.type,
    lemma: word.mot,
    displayForm: displayFormOf(word.mot),
    partOfSpeech: 'verb',
    primaryTranslation: `traduction corrigée de ${word.mot}`,
    translationStatus: 'incorrect',
    reviewRequired: true,
    reviewNote: 'note interne',
    senses: [{ senseKey: 'main', partOfSpeech: 'verb', translation: `traduction corrigée de ${word.mot}`, exampleEn: `I ${word.mot} often.`, exampleFr: 'Souvent.' }],
    collocations: [{ en: `${word.mot} away`, fr: 'au loin', kind: 'phrasal_verb', senseKey: 'main' }],
  };
}

/** Publie un enrichissement (50 premiers mots, ou les ids donnés) et renvoie les ids. */
async function publish(env: ReturnType<typeof createEnv>['env'], db: Db, ids?: string[], batchId = 'batch-join') {
  const sources = ids ? wordsById(db, ids.slice(0, 50)) : words(db);
  const response = await call(env, `/admin/vocabulary/batches/${batchId}/publish`, {
    method: 'POST', body: { schemaVersion: 1, batchId, entries: sources.map(entry) },
  });
  expect(response.status).toBe(200);
  return new Set(sources.map((word) => word.id));
}

function expectPublicEnrichment(word: ApiWord) {
  expect(word.enrichment).toMatchObject({
    schemaVersion: 1,
    version: 1,
    lemma: word.mot,
    displayForm: displayFormOf(word.mot),
    primaryTranslation: `traduction corrigée de ${word.mot}`,
    senses: [expect.objectContaining({ senseKey: 'main' })],
    collocations: [expect.objectContaining({ kind: 'phrasal_verb' })],
  });
  // Les champs d'audit de l'atelier ne sortent jamais vers la PWA.
  for (const field of ['originalWord', 'originalTranslation', 'originalType', 'reviewRequired', 'reviewNote', 'id']) {
    expect(word.enrichment).not.toHaveProperty(field);
  }
  // Les colonnes techniques de la jointure non plus.
  expect(word).not.toHaveProperty('enrichment_data');
  expect(word).not.toHaveProperty('enrichment_version');
}

describe('enrichissements joints aux routes d’apprentissage', () => {
  it('/words et /words/:id exposent le contrat public avec repli historique', async () => {
    const { env, db } = createEnv();
    const published = await publish(env, db);
    const source = words(db, 1)[0]!;
    const detail = await (await call(env, `/words/${source.id}`)).json() as ApiWord;
    expectPublicEnrichment(detail);
    expect(detail.traduction).toBe(source.traduction);
    for (const path of ['/words?limit=1000', `/words?niveau=${source.niveau}&limit=1000`]) {
      const { words: list } = await (await call(env, path)).json() as { words: ApiWord[] };
      expect(list.some((word) => published.has(word.id))).toBe(true);
      list.forEach((word) => {
        if (published.has(word.id)) expectPublicEnrichment(word);
        else expect(word.enrichment).toBeNull();
      });
    }
    expect((await call(env, '/words/absent')).status).toBe(404);
  });

  it('une nouvelle publication ne recrée pas les cartes et conserve toute la progression', async () => {
    const { env, db } = createEnv();
    const path = '/lingvist/session?profileId=default&limit=80';
    const before = await (await call(env, path)).json() as { words: ApiWord[]; cards: { wordId: string; qualityReasons: string[] }[] };
    const ids = before.words.map((word) => word.id);
    const progress = () => db.sqlite.prepare('SELECT * FROM word_progress ORDER BY profile_id, word_id').all();
    const validIds = before.cards.filter((card) => !card.qualityReasons.length).map((card) => card.wordId);
    expect(validIds.length).toBeGreaterThan(0);
    const cards = () => db.sqlite.prepare(`SELECT * FROM lingvist_cards WHERE word_id IN (${validIds.map(() => '?').join(',')}) ORDER BY id`).all(...validIds);
    const review = await call(env, '/srs/review', { method: 'POST', body: {
      profileId: 'default', wordId: ids[0], word: {
        id: ids[0], prochaine_revision: '2020-01-01', intervalle: 3, facilite: 2.6,
        repetitions: 2, derniere_revision: '2020-01-01', seen_count: 4,
        success_count: 2, almost_count: 1, fail_count: 1, level: 2, status: 'learning',
        review_history: [], lastGrade: 'good',
      }, day: '2026-10-19', count: 1, result: 'success',
    } });
    expect(review.status).toBe(200);
    const initialProgress = progress();
    expect(initialProgress.length).toBeGreaterThan(0);
    const initialCards = cards();
    await publish(env, db, ids);
    await call(env, path);
    // Deuxième publication : même correction, nouvelle version de l’atelier.
    await publish(env, db, ids, 'batch-join-v2');
    const refreshed = await (await call(env, path)).json() as { words: ApiWord[] };
    expect(refreshed.words.some((word) => word.enrichment?.version === 2)).toBe(true);
    expect(progress()).toEqual(initialProgress);
    expect(cards()).toEqual(initialCards);
  });

  it('les nouvelles cartes mémorisent la version publiée, les anciennes restent identiques', async () => {
    const { env, db } = createEnv();
    const probe = createEnv();
    const candidates = await (await call(probe.env, '/lingvist/session?profileId=default&limit=80')).json() as { words: ApiWord[] };
    await publish(env, db, candidates.words.map((word) => word.id));
    const response = await (await call(env, '/lingvist/session?profileId=default&limit=80')).json() as {
      cards: { wordId: string; enrichmentVersion: number | null }[];
    };
    expect(response.cards.some((card) => card.enrichmentVersion === 1)).toBe(true);
    for (const card of response.cards) {
      const enrichment = db.sqlite.prepare('SELECT version FROM vocabulary_enrichments WHERE word_id = ?').get(card.wordId) as { version: number } | undefined;
      expect(card.enrichmentVersion).toBe(enrichment?.version ?? null);
      const stored = db.sqlite.prepare('SELECT enrichment_version FROM lingvist_cards WHERE word_id = ?').get(card.wordId) as { enrichment_version: number | null };
      expect(stored.enrichment_version).toBe(card.enrichmentVersion);
    }
  });

  it('« Je connais » conserve le mot publié et son enrichissement', async () => {
    const { env, db } = createEnv();
    await publish(env, db);
    const source = words(db, 1)[0]!;
    const before = await (await call(env, `/words/${source.id}`)).json();
    const response = await call(env, '/srs/known', { method: 'POST', body: {
      profileId: 'default', wordIds: [source.id], source: 'user_marked_known',
    } });
    expect(response.status).toBe(200);
    const after = await (await call(env, `/words/${source.id}`)).json();
    expect(after).toEqual(before);
    const progress = db.sqlite.prepare('SELECT status FROM word_progress WHERE word_id = ?').get(source.id) as { status: string };
    expect(progress.status).toBe('known');
  });

  it('un import externe de carte retire une ancienne version devenue inconnue', async () => {
    const { env, db } = createEnv();
    const source = words(db, 1)[0]!;
    const body = { profileId: 'default', exampleEn: 'Prices range from 10 to 20.',
      lemma: 'range', expectedAnswer: 'range', sentenceWithGap: 'Prices ____ from 10 to 20.',
      sentenceFull: 'Prices range from 10 to 20.', translationFr: 'Les prix varient.',
      grammarHint: '', inputPlaceholder: 'Mot',
    };
    const path = `/lingvist/card/${source.id}`;
    expect((await call(env, path, { method: 'PUT', body })).status).toBe(200);
    db.sqlite.prepare('UPDATE lingvist_cards SET enrichment_version = 1 WHERE word_id = ?').run(source.id);
    expect((await call(env, path, { method: 'PUT', body })).status).toBe(200);
    const stored = db.sqlite.prepare('SELECT enrichment_version FROM lingvist_cards WHERE word_id = ?').get(source.id) as { enrichment_version: number | null };
    expect(stored.enrichment_version).toBeNull();
  });

  it('la régénération simulée trace la version réellement fournie au modèle', async () => {
    const { env, db } = createEnv();
    const source = db.sqlite.prepare("SELECT id FROM words WHERE mot = 'range' LIMIT 1").get() as { id: string };
    await publish(env, db, [source.id]);
    await call(env, `/lingvist/card/${source.id}`, { method: 'PUT', body: {
      profileId: 'default', exampleEn: 'Prices range from ten to twenty euros.',
      lemma: 'range', expectedAnswer: 'range', sentenceWithGap: 'Prices ____ from ten to twenty euros.',
      sentenceFull: 'Prices range from ten to twenty euros.', translationFr: 'Les prix varient.',
      grammarHint: '', inputPlaceholder: 'Mot', source: 'local', schemaVersion: 4,
    } });
    const run = vi.fn(async () => ({ response: {
      sentenceEn: 'Prices ranged from ten to twenty euros last summer.', answer: 'ranged',
      translationFr: 'Les prix allaient de dix à vingt euros.', grammarHintFr: 'Prétérit', verbFormLabel: 'prétérit',
    } }));
    Object.assign(env, { AI: { run } });
    expect(await regenerateLingvistCards(env, 1)).toBe(1);
    const stored = db.sqlite.prepare('SELECT enrichment_version, expected_answer FROM lingvist_cards WHERE word_id = ?').get(source.id);
    expect(stored).toMatchObject({ enrichment_version: 1, expected_answer: 'ranged' });
    expect(JSON.stringify(run.mock.calls)).toContain('traduction corrigée de range');
  });

  it('/srs/triage joint l’enrichissement, sans toucher au mot historique', async () => {
    const { env, db } = createEnv();
    const published = await publish(env, db);
    const response = await call(env, '/srs/triage?profileId=default&limit=5000');
    const { words: list } = await response.json() as { words: ApiWord[] };
    const enriched = list.filter((word) => published.has(word.id));
    expect(enriched.length).toBeGreaterThan(0);
    enriched.forEach(expectPublicEnrichment);
    const source = words(db, 1)[0]!;
    expect(list.find((word) => word.id === source.id)?.traduction).toBe(source.traduction);
    expect(list.filter((word) => !published.has(word.id)).every((word) => word.enrichment === null)).toBe(true);
  });

  it('/srs/progress joint l’enrichissement à chaque mot publié', async () => {
    const { env, db } = createEnv();
    const published = await publish(env, db);
    const { words: list } = await (await call(env, '/srs/progress?profileId=default')).json() as { words: ApiWord[] };
    const enriched = list.filter((word) => published.has(word.id));
    expect(enriched).toHaveLength(published.size);
    enriched.forEach(expectPublicEnrichment);
  });

  it('/srs/session et /lingvist/session exposent enrichment sur les mots publiés', async () => {
    const { env, db } = createEnv();
    const sessionIds = async (path: string) => ((await (await call(env, path)).json()) as { words: ApiWord[] }).words.map((word) => word.id);
    const ids = [
      ...(await sessionIds('/srs/session?profileId=default&limit=200')).slice(0, 25),
      ...(await sessionIds('/lingvist/session?profileId=default&limit=80')).slice(0, 25),
    ];
    const published = await publish(env, db, [...new Set(ids)]);
    for (const path of ['/srs/session?profileId=default&limit=200', '/lingvist/session?profileId=default&limit=80']) {
      const response = await call(env, path);
      expect(response.status).toBe(200);
      const { words: list } = await response.json() as { words: ApiWord[] };
      expect(list.some((word) => published.has(word.id))).toBe(true);
      list.forEach((word) => {
        if (published.has(word.id)) expectPublicEnrichment(word);
        else expect(word.enrichment).toBeNull();
      });
    }
  });

  it('/lingvist/session remplace l’ancienne traduction des cartes préparées', async () => {
    const { env, db } = createEnv();
    // 1. Cartes préparées avant toute correction.
    const before = await (await call(env, '/lingvist/session?profileId=default&limit=80')).json() as { words: ApiWord[] };
    const published = await publish(env, db, before.words.map((word) => word.id));
    // 2. Même session après publication : la carte en base garde l'ancienne traduction…
    const { cards } = await (await call(env, '/lingvist/session?profileId=default&limit=80')).json() as {
      cards: { wordId: string; lemma: string; wordTraductionFr: string }[];
    };
    const corrected = cards.filter((card) => published.has(card.wordId));
    // …mais la réponse expose la traduction publiée.
    corrected.forEach((card) => expect(card.wordTraductionFr).toBe(`traduction corrigée de ${card.lemma}`));
    expect(corrected.length).toBeGreaterThan(0);
    {
      const stored = db.sqlite.prepare('SELECT word_traduction_fr FROM lingvist_cards WHERE word_id = ?').get(corrected[0]!.wordId) as { word_traduction_fr: string | null };
      expect(stored.word_traduction_fr).not.toBe(`traduction corrigée de ${corrected[0]!.lemma}`);
    }
  });
});

describe('toVocabularyEnrichmentDto', () => {
  it('renvoie null sans donnée ou avec un JSON illisible', () => {
    expect(toVocabularyEnrichmentDto({})).toBeNull();
    expect(toVocabularyEnrichmentDto({ enrichment_data: '{oops' })).toBeNull();
    expect(toVocabularyEnrichmentDto({ enrichment_data: JSON.stringify({ lemma: '' }) })).toBeNull();
  });

  it('ignore les sens et collocations mal formés et retire « to » du lemme', () => {
    const dto = toVocabularyEnrichmentDto({
      enrichment_data: JSON.stringify({
        lemma: 'to range', displayForm: 'to range', partOfSpeech: 'verb', primaryTranslation: 'aller de… à…',
        senses: [null, { senseKey: 'x' }, { senseKey: 'ok', translation: 'aller' }],
        collocations: ['texte', { en: '' }, { en: 'range from', fr: 'aller de' }],
      }),
      enrichment_version: 2,
      enrichment_published_at: '2026-10-16T22:55:51.942Z',
    });
    expect(dto).toMatchObject({ lemma: 'range', displayForm: 'to range', version: 2 });
    expect(dto?.senses.map((sense) => sense.senseKey)).toEqual(['ok']);
    expect(dto?.collocations).toEqual([{ en: 'range from', fr: 'aller de', kind: 'collocation', senseKey: '' }]);
  });
});

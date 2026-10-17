import { describe, expect, it } from 'vitest';

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
async function publish(env: ReturnType<typeof createEnv>['env'], db: Db, ids?: string[]) {
  const sources = ids ? wordsById(db, ids.slice(0, 50)) : words(db);
  const batchId = 'batch-join';
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

import { describe, expect, it, vi } from 'vitest';

import { buildDraftEntry, normalizeGeneratedCard, runNightlyAiPass } from '../src/nightlyAi';
import { normalizeLiveAnalysis } from '../src/liveAnalysis';
import { call, createEnv } from './support/env';

describe('régénération des cartes Lingvist', () => {
  it('accepte une forme fléchie présente dans la phrase et construit le trou', () => {
    const card = normalizeGeneratedCard({
      sentenceEn: 'Prices ranged from ten to twenty euros last summer.', answer: 'ranged',
      translationFr: 'Les prix allaient de dix à vingt euros l’été dernier.', grammarHintFr: 'Verbe au prétérit', verbFormLabel: 'prétérit',
    }, 'range');
    expect(card).toMatchObject({ expectedAnswer: 'ranged', sentenceWithGap: 'Prices ____ from ten to twenty euros last summer.' });
  });

  it('rejette une réponse absente de la phrase ou sans rapport avec le mot', () => {
    expect(normalizeGeneratedCard({ sentenceEn: 'Prices go from ten to twenty euros today.', answer: 'range', translationFr: 'x', grammarHintFr: 'x' }, 'range')).toBeNull();
    expect(normalizeGeneratedCard({ sentenceEn: 'Prices vary from ten to twenty euros today.', answer: 'vary', translationFr: 'x', grammarHintFr: 'x' }, 'range')).toBeNull();
    expect(normalizeGeneratedCard({ sentenceEn: 'Too short.', answer: 'short', translationFr: 'x', grammarHintFr: 'x' }, 'short')).toBeNull();
  });
});

describe('brouillons d’enrichissement', () => {
  const source = { id: 'range_1879', mot: 'range', traduction: 'intervalle', type: 'noun', niveau: 'B1' };
  const draft = {
    lemma: 'range', displayForm: 'to range', partOfSpeech: 'verb', primaryTranslation: 'aller de… à…', translationStatus: 'incorrect',
    senses: [{ senseKey: 'vary-between-limits', partOfSpeech: 'verb', translation: 'aller de… à…', exampleEn: 'Prices range from 10 to 20 euros.', exampleFr: 'Les prix vont de 10 à 20 euros.' }],
    collocations: [{ en: 'range from … to …', fr: 'aller de… à…', kind: 'grammar_pattern', senseKey: 'vary-between-limits' }],
  };

  it('produit une entrée valide au format de l’atelier, marquée à relire', () => {
    const { entry, errors } = buildDraftEntry(draft, source);
    expect(errors).toEqual([]);
    expect(entry).toMatchObject({ id: 'range_1879', originalWord: 'range', originalTranslation: 'intervalle', reviewRequired: true });
  });

  it('signale une entrée invalide (modal avec « to »)', () => {
    const { errors } = buildDraftEntry({ ...draft, lemma: 'can', displayForm: 'to can', partOfSpeech: 'modal_verb' }, { ...source, mot: 'can' });
    expect(errors).toContain('un modal ne peut pas commencer par « to »');
  });
});

describe('passe de nuit', () => {
  it('s’arrête dès que le budget du jour est atteint', async () => {
    const { env, db } = createEnv();
    const run = vi.fn();
    Object.assign(env, { AI: { run } });
    db.sqlite.prepare("INSERT INTO ai_usage_daily (day, neurons, calls) VALUES (?, 9000, 10)").run(new Date().toISOString().slice(0, 10));
    const report = await runNightlyAiPass(env, 8000);
    expect(report.stoppedOnBudget).toBe(true);
    expect(report.steps).toEqual({});
    expect(run).not.toHaveBeenCalled();
  });

  it('est protégée par authentification', async () => {
    const { env } = createEnv();
    expect((await call(env, '/admin/ai/nightly', { method: 'POST', auth: false })).status).toBe(401);
    expect((await call(env, '/admin/vocabulary/drafts', { auth: false })).status).toBe(401);
  });
});

describe('analyse des bilans Live', () => {
  it('garde les erreurs réelles et des expressions courtes sans doublon', () => {
    const analysis = normalizeLiveAnalysis({
      summaryFr: 'Bonne séance.',
      strengths: ['Fluidité'],
      errors: [{ wrong: 'I am agree', correct: 'I agree', explanationFr: 'agree est un verbe' }, { wrong: 'same', correct: 'same', explanationFr: '' }],
      expressions: [
        { en: 'make a decision', fr: 'prendre une décision', example: 'We must make a decision.' },
        { en: 'Make a decision', fr: 'prendre une décision', example: '' },
        { en: 'a phrase that is far too long to be a reusable expression', fr: 'trop long', example: '' },
      ],
    });
    expect(analysis?.errors).toHaveLength(1);
    expect(analysis?.expressions.map((item) => item.en)).toEqual(['make a decision']);
  });

  it('refuse un bilan trop court et enregistre une analyse réussie', async () => {
    const { env, db } = createEnv();
    Object.assign(env, { AI: { run: vi.fn(async () => ({ response: { summaryFr: 'Résumé.', strengths: [], errors: [], expressions: [{ en: 'win-win', fr: 'gagnant-gagnant', example: 'A win-win deal.' }] } })) } });
    expect((await call(env, '/live/analyze', { method: 'POST', body: { report: 'court' } })).status).toBe(400);
    const response = await call(env, '/live/analyze', { method: 'POST', body: { profileId: 'default', report: 'Strengths: good flow. Mistakes: none really. Expressions: win-win.' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ analysis: { expressions: [{ en: 'win-win' }] } });
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM live_report_analyses').get()).toMatchObject({ n: 1 });
  });
});

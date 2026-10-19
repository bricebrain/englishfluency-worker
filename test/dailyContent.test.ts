import { describe, expect, it, vi } from 'vitest';

import { normalizeSentenceExercises, normalizeStory } from '../src/dailyContent';
import { call, createEnv } from './support/env';

const targets = [
  { id: 'w1', word: 'range', translation: 'aller de… à…', level: 'B1' },
  { id: 'w2', word: 'reliable', translation: 'fiable', level: 'B1' },
];

const sentences = {
  exercises: [
    { prompt: 'Les prix vont de 10 à 20 euros.', expected: 'Prices range from 10 to 20 euros.', hint: 'Présent simple', distractors: ['vary', 'prices', 'among', 'between'], word: 'range' },
    { prompt: 'C’est une collègue fiable.', expected: 'She is a reliable colleague', hint: 'Adjectif', distractors: ['trust'], word: 'reliable' },
    { prompt: 'Il pleut.', expected: 'It rains', hint: '', distractors: [], word: 'rain' },
    { prompt: 'Nous avons travaillé ici pendant longtemps.', expected: 'We have worked here for a long time', hint: 'Present perfect', distractors: ['since'], word: 'inconnu' },
    { prompt: '', expected: 'Missing prompt here today', hint: '', distractors: [], word: 'range' },
  ],
};

const storyText = Array.from({ length: 12 }, (_, index) => `Tom checked the price range of reliable bikes number ${index}.`).join(' ');
const story = { title: 'A new bike', textEn: storyText, textFr: 'Tom a comparé des vélos.', questions: [{ question: 'What did Tom check?', answer: 'The price range.' }] };

describe('validation des contenus générés', () => {
  it('écarte les exercices mal formés et filtre les distracteurs', () => {
    const exercises = normalizeSentenceExercises(sentences, targets);
    expect(exercises.map((exercise) => exercise.expected)).toEqual([
      'Prices range from 10 to 20 euros',
      'She is a reliable colleague',
      'We have worked here for a long time',
    ]); // « It rains » (2 mots) et la consigne vide sont écartés
    expect(exercises[0]).toMatchObject({ wordId: 'w1', distractors: ['vary', 'among', 'between'] });
    expect(exercises[2]?.wordId).toBe('');
  });

  it('refuse une histoire trop courte et repère les mots utilisés', () => {
    expect(normalizeStory({ ...story, textEn: 'Too short.' }, targets)).toBeNull();
    expect(normalizeStory(story, targets)).toMatchObject({ title: 'A new bike', wordsUsed: ['range', 'reliable'] });
  });
});
describe('GET /exercises/daily', () => {
  it('génère une fois par jour puis sert le cache', async () => {
    const { env, db } = createEnv();
    const run = vi.fn(async () => ({ response: sentences, usage: { prompt_tokens: 400, completion_tokens: 600 } }));
    Object.assign(env, { AI: { run } });
    const first = await call(env, '/exercises/daily?profileId=default&kind=sentences');
    expect(first.status).toBe(200);
    const body = await first.json() as { generated: boolean; payload: { exercises: unknown[] } };
    expect(body.generated).toBe(true);
    expect(body.payload.exercises.length).toBeGreaterThanOrEqual(3);

    const second = await (await call(env, '/exercises/daily?profileId=default&kind=sentences')).json() as { generated: boolean };
    expect(second.generated).toBe(false);
    // Génération + contrôle de fidélité des traductions, puis plus aucun appel (cache).
    expect(run).toHaveBeenCalledTimes(2);
    const usage = db.sqlite.prepare('SELECT neurons, calls FROM ai_usage_daily').get() as { neurons: number; calls: number };
    expect(usage.calls).toBe(2);
    expect(usage.neurons).toBeGreaterThan(100);
  });

  it('génère l’histoire du jour', async () => {
    const { env } = createEnv();
    Object.assign(env, { AI: { run: vi.fn(async () => ({ response: story })) } });
    const body = await (await call(env, '/exercises/daily?profileId=default&kind=story')).json() as { payload: { title: string; questions: unknown[] } };
    expect(body.payload).toMatchObject({ title: 'A new bike' });
    expect(body.payload.questions).toHaveLength(1);
  });

  it('refuse un type inconnu et signale une génération inexploitable', async () => {
    const { env } = createEnv();
    Object.assign(env, { AI: { run: vi.fn(async () => ({ response: { exercises: [] } })) } });
    expect((await call(env, '/exercises/daily?kind=autre')).status).toBe(400);
    expect((await call(env, '/exercises/daily?profileId=default&kind=sentences')).status).toBe(503);
  });
});

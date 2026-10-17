import { afterEach, describe, expect, it, vi } from 'vitest';

import { WORKERS_AI_ANALYSIS_MODEL, normalizeAnalysisPayload } from '../src/lingvistAnalysis';
import { call, createEnv } from './support/env';

const card = {
  level: 'B1',
  expectedAnswer: 'range',
  wordTraductionFr: 'aller de… à…',
  sentenceFull: 'Prices range from 10 to 20 euros.',
  grammarHint: 'Verbe au présent',
};

const analysis = {
  result: 'almost',
  score: 0.6,
  shortFeedback: 'Presque',
  explanation: '« vary » est proche mais « range from … to … » est la structure attendue.',
  examples: ['Prices range from 10 to 20 euros.'],
  commonMistakes: ['range between'],
  usageCases: ['Donner un intervalle'],
};

function envWithAi(run: (model: string, input: unknown) => Promise<unknown>) {
  const { env } = createEnv();
  return Object.assign(env, { AI: { run: vi.fn(run) } });
}

afterEach(() => vi.unstubAllGlobals());

describe('POST /lingvist/analyze', () => {
  it('refuse sans authentification', async () => {
    const env = envWithAi(async () => ({ response: analysis }));
    const response = await call(env, '/lingvist/analyze', { method: 'POST', auth: false, body: { card, answer: 'vary' } });
    expect(response.status).toBe(401);
  });

  it('refuse une carte ou une réponse vide', async () => {
    const env = envWithAi(async () => ({ response: analysis }));
    expect((await call(env, '/lingvist/analyze', { method: 'POST', body: { card: {}, answer: 'vary' } })).status).toBe(400);
    expect((await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: '  ' } })).status).toBe(400);
  });

  it('utilise Workers AI en priorité, avec le contexte de la carte', async () => {
    const env = envWithAi(async () => ({ response: analysis }));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const response = await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: 'vary' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'workers-ai', analysis: { result: 'almost', score: 0.6 } });
    const [model, input] = (env.AI as unknown as { run: ReturnType<typeof vi.fn> }).run.mock.calls[0]!;
    expect(model).toBe(WORKERS_AI_ANALYSIS_MODEL);
    expect(JSON.stringify(input)).toContain('aller de… à…');
    expect(JSON.stringify(input)).toContain('Réponse saisie : \\"vary\\"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepte une réponse Workers AI en texte JSON entouré de balises', async () => {
    const env = envWithAi(async () => ({ response: `Voici :\n\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` }));
    const response = await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: 'vary' } });
    expect(await response.json()).toMatchObject({ provider: 'workers-ai' });
  });

  it('bascule sur DeepSeek si Workers AI échoue (quota, erreur…)', async () => {
    const env = envWithAi(async () => { throw new Error('4006: daily free allocation exceeded'); });
    const fetchSpy = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const response = await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: 'vary' } });
    expect(await response.json()).toMatchObject({ provider: 'deepseek', analysis: { result: 'almost' } });
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('bascule sur DeepSeek si Workers AI renvoie un JSON inexploitable', async () => {
    const env = envWithAi(async () => ({ response: '{"result":"peut-être"}' }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] })));
    const response = await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: 'vary' } });
    expect(await response.json()).toMatchObject({ provider: 'deepseek' });
  });

  it('renvoie 502 si les deux fournisseurs échouent', async () => {
    const env = envWithAi(async () => { throw new Error('indisponible'); });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('erreur', { status: 500 })));
    const response = await call(env, '/lingvist/analyze', { method: 'POST', body: { card, answer: 'vary' } });
    expect(response.status).toBe(502);
  });
});

describe('normalizeAnalysisPayload', () => {
  it('borne le score et limite les listes', () => {
    const payload = normalizeAnalysisPayload({ ...analysis, score: 4, examples: ['a', 'b', 'c', 'd', 'e', 7] });
    expect(payload?.score).toBe(1);
    expect(payload?.examples).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejette un verdict inconnu ou une explication vide', () => {
    expect(normalizeAnalysisPayload({ ...analysis, result: 'maybe' })).toBeNull();
    expect(normalizeAnalysisPayload({ ...analysis, explanation: '' })).toBeNull();
    expect(normalizeAnalysisPayload('pas du json')).toBeNull();
  });
});

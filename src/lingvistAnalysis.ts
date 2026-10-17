import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

/**
 * POST /lingvist/analyze — correction d'une réponse Lingvist par IA.
 * Workers AI d'abord (quota quotidien gratuit du compte), DeepSeek en secours.
 * La PWA n'appelle cette route que si sa vérification locale juge la réponse fausse.
 */

export const WORKERS_AI_ANALYSIS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MAX_FIELD = 600;

type Provider = 'workers-ai' | 'deepseek';

interface AnalyzeBody {
  answer?: unknown;
  card?: Record<string, unknown>;
}

export interface LingvistAnalysisPayload {
  result: 'success' | 'almost' | 'fail';
  score: number;
  shortFeedback: string;
  explanation: string;
  examples: string[];
  commonMistakes: string[];
  usageCases: string[];
}

const SYSTEM_PROMPT = 'Tu corriges un mot anglais en contexte pour un francophone. Réponds seulement en JSON valide, en français.';

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['success', 'almost', 'fail'] },
    score: { type: 'number' },
    shortFeedback: { type: 'string' },
    explanation: { type: 'string' },
    examples: { type: 'array', items: { type: 'string' } },
    commonMistakes: { type: 'array', items: { type: 'string' } },
    usageCases: { type: 'array', items: { type: 'string' } },
  },
  required: ['result', 'score', 'shortFeedback', 'explanation', 'examples', 'commonMistakes', 'usageCases'],
};

function field(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD) : '';
}

export function buildAnalysisPrompt(card: Record<string, unknown>, answer: string): string {
  return [
    'Exercice de vocabulaire anglais : compléter uniquement le mot manquant.',
    `Niveau : ${field(card.level) || 'B1'}`,
    `Mot attendu : "${field(card.expectedAnswer)}"`,
    `Sens français : ${field(card.wordTraductionFr) || field(card.translationFr)}`,
    `Phrase complète : "${field(card.sentenceFull)}"`,
    `Réponse saisie : "${answer}"`,
    `Indice grammatical : ${field(card.grammarHint)}`,
    'Accepte un synonyme uniquement s’il fonctionne réellement dans cette phrase.',
    'Retourne seulement ce JSON :',
    '{"result":"success|almost|fail","score":0.0,"shortFeedback":"...","explanation":"...","examples":["..."],"commonMistakes":["..."],"usageCases":["..."]}',
  ].join('\n');
}

function extractJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return null;
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) ?? raw.match(/```\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 4) : [];
}

/** Valide la sortie du modèle ; `null` si elle est inexploitable. */
export function normalizeAnalysisPayload(raw: unknown): LingvistAnalysisPayload | null {
  const data = extractJson(raw);
  if (!data) return null;
  const result = String(data.result ?? '').toLowerCase();
  if (result !== 'success' && result !== 'almost' && result !== 'fail') return null;
  const explanation = field(data.explanation);
  if (!explanation) return null;
  const score = typeof data.score === 'number' && Number.isFinite(data.score) ? Math.max(0, Math.min(1, data.score)) : result === 'success' ? 1 : result === 'almost' ? 0.6 : 0;
  return {
    result,
    score,
    shortFeedback: field(data.shortFeedback),
    explanation,
    examples: strings(data.examples),
    commonMistakes: strings(data.commonMistakes),
    usageCases: strings(data.usageCases),
  };
}

async function analyzeWithWorkersAi(env: Env, prompt: string): Promise<LingvistAnalysisPayload | null> {
  if (!env.AI) return null;
  const output = await env.AI.run(WORKERS_AI_ANALYSIS_MODEL as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0.1,
    max_tokens: 600,
    response_format: { type: 'json_schema', json_schema: ANALYSIS_SCHEMA },
  } as Record<string, unknown>) as { response?: unknown } | null;
  return normalizeAnalysisPayload(output?.response);
}

async function analyzeWithDeepSeek(env: Env, prompt: string): Promise<LingvistAnalysisPayload | null> {
  const apiKey = await env.DEEPSEEK_API_KEY.get().catch(() => null);
  if (!apiKey) return null;
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!response.ok) return null;
  const data = await response.json<{ choices?: { message?: { content?: string } }[] }>().catch(() => null);
  return normalizeAnalysisPayload(data?.choices?.[0]?.message?.content);
}

export async function handleLingvistAnalyze(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<AnalyzeBody>().catch(() => null);
  const answer = field(body?.answer);
  const card = body?.card && typeof body.card === 'object' ? body.card : null;
  if (!card || !field(card.expectedAnswer) || !field(card.sentenceFull)) return err('Carte invalide');
  if (!answer) return err('Réponse vide');

  const prompt = buildAnalysisPrompt(card, answer);
  const attempts: { provider: Provider; run: () => Promise<LingvistAnalysisPayload | null> }[] = [
    { provider: 'workers-ai', run: () => analyzeWithWorkersAi(env, prompt) },
    { provider: 'deepseek', run: () => analyzeWithDeepSeek(env, prompt) },
  ];
  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const analysis = await attempt.run();
      if (analysis) return json({ analysis, provider: attempt.provider });
      failures.push(`${attempt.provider}: réponse inexploitable`);
    } catch (error) {
      failures.push(`${attempt.provider}: ${error instanceof Error ? error.message.slice(0, 160) : 'erreur'}`);
    }
  }
  console.warn('lingvist/analyze sans résultat', failures);
  return json({ error: 'Analyse indisponible', failures }, 502);
}

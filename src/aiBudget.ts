import type { Env } from './types';

/**
 * Appels Workers AI avec suivi de la consommation estimée (neurones / jour UTC).
 * Le quota gratuit est de 10 000 neurones par jour : les tâches nocturnes
 * s'arrêtent avant ce plafond, en laissant une marge pour l'usage de la journée.
 */

export const DAILY_NEURON_ALLOWANCE = 10_000;
/** Ce que les tâches nocturnes peuvent consommer au maximum (marge pour le jour). */
export const NIGHTLY_NEURON_BUDGET = 8_000;

export const MODELS = {
  /** Correction rapide (Lingvist) et tâches simples. */
  fast: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
  /** Génération de contenus où la justesse de l'anglais compte. */
  quality: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embedding: '@cf/baai/bge-m3',
} as const;

/** Neurones par million de tokens (grille Cloudflare, entrée / sortie). */
const PRICES: Record<string, [number, number]> = {
  [MODELS.fast]: [4119, 34868],
  [MODELS.quality]: [26668, 204805],
  [MODELS.embedding]: [1075, 0],
};

export function estimateNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const [input, output] = PRICES[model] ?? [30_000, 200_000];
  return (inputTokens * input + outputTokens * output) / 1_000_000;
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export async function recordAiUsage(env: Env, neurons: number, calls = 1): Promise<void> {
  if (!(neurons > 0)) return;
  await env.DB.prepare(`
    INSERT INTO ai_usage_daily (day, neurons, calls, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(day) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + excluded.calls, updated_at = datetime('now')
  `).bind(utcDay(), neurons, calls).run();
}

export async function usedNeuronsToday(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT neurons FROM ai_usage_daily WHERE day = ?').bind(utcDay()).first<{ neurons: number }>();
  return row?.neurons ?? 0;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
}

/** Texte généré par un modèle de chat, consommation enregistrée. */
export async function runChat(env: Env, model: string, messages: ChatMessage[], options: ChatOptions = {}): Promise<unknown> {
  if (!env.AI) throw new Error('Binding Workers AI absent');
  const input: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 800,
  };
  if (options.jsonSchema) input.response_format = { type: 'json_schema', json_schema: options.jsonSchema };
  const output = await env.AI.run(model as Parameters<Ai['run']>[0], input) as {
    response?: unknown;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const inputTokens = output?.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(messages).length / 4);
  const outputTokens = output?.usage?.completion_tokens ?? Math.ceil(JSON.stringify(output?.response ?? '').length / 4);
  await recordAiUsage(env, estimateNeurons(model, inputTokens, outputTokens)).catch(() => undefined);
  return output?.response;
}

/** Vecteurs bge-m3 (1024 dimensions) pour une liste de textes. */
export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI) throw new Error('Binding Workers AI absent');
  if (!texts.length) return [];
  const output = await env.AI.run(MODELS.embedding as Parameters<Ai['run']>[0], { text: texts } as never) as { data?: number[][] };
  const tokens = texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
  await recordAiUsage(env, estimateNeurons(MODELS.embedding, tokens, 0)).catch(() => undefined);
  return output?.data ?? [];
}

/** Extrait un objet JSON d'une réponse de modèle (objet direct ou texte). */
export function extractJsonObject(raw: unknown): Record<string, unknown> | null {
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

export function cleanString(value: unknown, max = 600): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function cleanStringList(value: unknown, max = 6, maxLength = 300): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanString(item, maxLength)).filter(Boolean).slice(0, max)
    : [];
}

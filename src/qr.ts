/**
 * POST /qr/generate  — génère une question d'expression écrite calibrée CEFR
 * POST /qr/analyze   — évalue la réponse (scores + erreurs + points à travailler)
 *
 * Pipeline : Gemini 3.5 Flash → fallback DeepSeek V4 Flash
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

// ─── Prompts ──────────────────────────────────────────────────────────────────

const GENERATE_SYSTEM = `You are an English-learning assessment engine for French speakers.
Return ONLY strict JSON with no markdown, no code block, no extra text.
The question prompt language must match the requested language (fr or en).
The learner must always answer in English.`;

function buildGenerateUser(input: {
  level: string;
  type: string;
  promptLanguage: string;
  targetSkills: string[];
}): string {
  return [
    'Generate one writing question for an English learner.',
    `Level: ${input.level}`,
    `Question type: ${input.type}`,
    `Prompt language: ${input.promptLanguage}`,
    `Target skills: ${input.targetSkills.join(', ') || 'none'}`,
    'Constraints:',
    '- prompt language must exactly match the requested language (fr → French, en → English)',
    '- answerLanguage is always "en"',
    '- set minWords/maxWords adapted to level and type (e.g. A2: 30-70, B1: 60-120, B2+: 80-160)',
    '- include 2 to 4 mustInclude constraints (short phrases the learner must use or address)',
    'Return JSON with exactly these fields:',
    '{"id":"q_001","title":"...","prompt":"...","minWords":60,"maxWords":120,"mustInclude":["...","..."]}',
  ].join('\n');
}

const ANALYZE_SYSTEM = `You are an English writing evaluator for French-speaking learners.
Return ONLY strict JSON with no markdown, no code block, no extra text.
Be constructive and precise. Focus on practical, prioritized feedback.`;

function buildAnalyzeUser(input: {
  questionPrompt: string;
  promptLanguage: string;
  minWords: number;
  maxWords: number;
  mustInclude: string[];
  answer: string;
  level: string;
}): string {
  return [
    `Evaluate this English learner answer. Learner CEFR level: ${input.level}`,
    `Question (${input.promptLanguage}): ${input.questionPrompt}`,
    `Expected word range: ${input.minWords}–${input.maxWords} words`,
    `Must address: ${input.mustInclude.join(', ') || 'none'}`,
    `Learner answer:\n${input.answer}`,
    '',
    'Return JSON with exactly these keys:',
    '{',
    '  "scores": {"taskCompletion":0-100,"grammar":0-100,"vocabulary":0-100,"coherence":0-100,"naturalness":0-100},',
    '  "detectedLevel": "A2|B1|B2|C1",',
    '  "strengths": ["..."],',
    '  "errors": [{"type":"grammar|vocabulary|coherence|naturalness|task_completion","message":"...","exampleFix":"..."}],',
    '  "focusPoints": [{"skill":"...","reason":"...","priority":1}],',
    '  "nextExerciseSuggestion": {"type":"message|opinion|story","targetSkills":["..."],"difficulty":"A2|B1|B2|C1"},',
    '  "summary": "..."',
    '}',
  ].join('\n');
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

async function callLlm(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json<{ choices?: [{ message?: { content?: string } }] }>();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function callWithFallback(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  temperature: number,
  maxTokens: number,
): Promise<Record<string, unknown> | null> {
  // 1. Gemini 3.5 Flash
  const geminiKey = await env.GEMINI_API_KEY.get();
  if (geminiKey) {
    const result = await callLlm(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      geminiKey,
      'gemini-3.5-flash',
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens,
    );
    if (result) return result;
  }

  // 2. DeepSeek V4 Flash
  const deepseekKey = await env.DEEPSEEK_API_KEY.get();
  if (deepseekKey) {
    const result = await callLlm(
      'https://api.deepseek.com/chat/completions',
      deepseekKey,
      'deepseek-v4-flash',
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens,
    );
    if (result) return result;
  }

  return null;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

interface GenerateRequest {
  level?: string;
  type?: string;
  promptLanguage?: string;
  targetSkills?: string[];
}

interface AnalyzeRequest {
  question?: {
    prompt?: string;
    promptLanguage?: string;
    minWords?: number;
    maxWords?: number;
    mustInclude?: string[];
    level?: string;
  };
  answer?: string;
  level?: string;
}

export async function handleQrGenerate(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<GenerateRequest>().catch(() => null);
  if (!body?.level || !body?.type) return err('level et type requis', 400);

  const userPrompt = buildGenerateUser({
    level: body.level,
    type: body.type,
    promptLanguage: body.promptLanguage ?? 'fr',
    targetSkills: body.targetSkills ?? [],
  });

  const result = await callWithFallback(env, GENERATE_SYSTEM, userPrompt, 0.65, 400);
  if (!result) return err('Génération de question indisponible', 503);

  return json(result);
}

export async function handleQrAnalyze(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<AnalyzeRequest>().catch(() => null);
  if (!body?.question?.prompt || !body?.answer?.trim()) {
    return err('question.prompt et answer requis', 400);
  }

  const userPrompt = buildAnalyzeUser({
    questionPrompt: body.question.prompt,
    promptLanguage: body.question.promptLanguage ?? 'fr',
    minWords: body.question.minWords ?? 50,
    maxWords: body.question.maxWords ?? 150,
    mustInclude: body.question.mustInclude ?? [],
    answer: body.answer.trim(),
    level: body.level ?? body.question.level ?? 'B1',
  });

  const result = await callWithFallback(env, ANALYZE_SYSTEM, userPrompt, 0.3, 800);
  if (!result) return err('Analyse indisponible', 503);

  return json(result);
}

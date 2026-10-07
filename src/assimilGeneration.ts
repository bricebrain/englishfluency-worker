import type { Env } from './types';
import type { AssimilLessonArtifact, AssimilLevel } from './assimilModel';

export type AssimilGenerationProvider = 'deepseek' | 'gemini';

export class AssimilGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssimilGenerationError';
  }
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    return JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractGeminiText(data: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string | null {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text).filter(Boolean).join('\n').trim();
  return text || null;
}

function buildPrompt(index: number, level: AssimilLevel, transcript: string): string {
  return `Create a private learning artifact for an Assimil-style English audio lesson.

Lesson index: ${index}
CEFR level estimate: ${level}
Audio transcript:
"""${transcript.slice(0, 7000)}"""

Return this exact JSON shape:
{
  "titleEn": "short English title",
  "titleFr": "short French title",
  "summaryFr": "2-3 sentence French summary of what the learner trains",
  "objectives": ["French objective 1", "French objective 2", "French objective 3"],
  "sentences": [
    {
      "id": "s1",
      "textEn": "English sentence or short chunk from the transcript",
      "textFr": "natural French meaning, not word-for-word",
      "focus": "grammar/vocab focus",
      "pronunciationTipFr": "short actionable French pronunciation tip"
    }
  ],
  "notes": [
    {
      "id": "n1",
      "topic": "grammar or vocabulary point",
      "explanationFr": "clear French explanation",
      "examples": [{"en": "English example", "fr": "French meaning"}]
    }
  ],
  "exercises": [
    {
      "id": "dictation_1",
      "type": "dictation",
      "instructionFr": "Listen and write the sentence",
      "items": [{"prompt": "audio_sentence_s1", "answer": "Expected sentence", "hintFr": "short hint", "focus": "target"}]
    },
    {
      "id": "blank_1",
      "type": "fill_blank",
      "instructionFr": "Complete the sentence",
      "items": [{"prompt": "Sentence with ____", "answer": "missing word", "hintFr": "French hint only", "focus": "target"}]
    },
    {
      "id": "translate_1",
      "type": "translation",
      "instructionFr": "Translate into English",
      "items": [{"prompt": "French prompt", "answer": "English answer", "hintFr": "do not give the English answer", "focus": "target"}]
    },
    {
      "id": "shadowing_1",
      "type": "shadowing",
      "instructionFr": "Repeat aloud with rhythm and stress",
      "items": [{"prompt": "English sentence", "answer": "same English sentence", "hintFr": "pronunciation cue", "focus": "rhythm"}]
    }
  ],
  "recyclingTargets": [
    {"term": "word or structure", "reasonFr": "why it matters", "skill": "vocabulary"}
  ]
}

Rules:
- Create 4 to 10 sentence chunks, not more.
- French hints in fill_blank and translation must not reveal the English answer.
- Notes must explain what a learner is likely to misunderstand.
- Pronunciation tips must be actionable, not phonetic noise.
- Do not mention the book or page screenshots.
- Avoid padding; quality over quantity.`;
}

/**
 * Traduit en français, phrase par phrase, les répliques du dialogue (1ʳᵉ lecture).
 * Un seul appel DeepSeek, alignement strict par index. En cas d'échec, renvoie
 * des chaînes vides (la VF reste simplement masquée côté app).
 */
export async function translateLinesToFrench(
  env: Env,
  lines: string[],
): Promise<string[]> {
  const empty = lines.map(() => '');
  if (!lines.length) return empty;

  const apiKey = await env.DEEPSEEK_API_KEY.get().catch(() => null);
  if (!apiKey) return empty;

  const numbered = lines.map((line, index) => `${index}. ${line}`).join('\n');
  const prompt = [
    'Traduis en français naturel chaque réplique anglaise ci-dessous (sens, pas mot-à-mot).',
    'Conserve exactement le même nombre d\'entrées et le même ordre.',
    'Réponds uniquement par ce JSON: { "translations": [{ "i": 0, "fr": "..." }] }',
    '',
    numbered,
  ].join('\n');

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: 'You translate English learner sentences into natural French. Respond only with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  }).catch(() => null);

  if (!res || !res.ok) return empty;

  const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) return empty;

  const parsed = extractJsonObject(raw) as { translations?: Array<{ i?: number; fr?: string }> } | null;
  const out = [...empty];
  for (const entry of parsed?.translations ?? []) {
    if (typeof entry.i === 'number' && entry.i >= 0 && entry.i < out.length && typeof entry.fr === 'string') {
      out[entry.i] = entry.fr.trim();
    }
  }
  return out;
}

async function generateAssimilArtifactWithDeepSeek(
  env: Env,
  index: number,
  level: AssimilLevel,
  transcript: string,
): Promise<AssimilLessonArtifact> {
  const apiKey = await env.DEEPSEEK_API_KEY.get().catch(() => null);
  if (!apiKey) throw new AssimilGenerationError('DEEPSEEK_API_KEY manquant');

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'system',
          content:
            'You are a senior English pedagogy architect for a French learner. ' +
            'Build high-quality original lesson material from an audio transcript. ' +
            'Be precise, practical, and aligned with CEFR progression. Respond only with valid JSON.',
        },
        { role: 'user', content: buildPrompt(index, level, transcript) },
      ],
      temperature: 0.25,
      max_tokens: 5200,
      response_format: { type: 'json_object' },
    }),
  }).catch((error) => {
    throw new AssimilGenerationError(error instanceof Error ? error.message : 'DeepSeek fetch failed');
  });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new AssimilGenerationError(`DeepSeek HTTP ${res.status}: ${preview.slice(0, 240)}`);
  }
  const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new AssimilGenerationError('DeepSeek response without message content');

  const parsed = extractJsonObject(raw) as AssimilLessonArtifact | null;
  if (!parsed) {
    throw new AssimilGenerationError(`DeepSeek JSON parse failed: ${raw.slice(0, 240)}`);
  }

  return parsed;
}

async function generateAssimilArtifactWithGemini(
  env: Env,
  index: number,
  level: AssimilLevel,
  transcript: string,
  model = 'gemini-3.5-flash',
): Promise<AssimilLessonArtifact> {
  const apiKey = await env.GEMINI_API_KEY.get().catch(() => null);
  if (!apiKey) throw new AssimilGenerationError('GEMINI_API_KEY manquant');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: [
              'You are a senior English pedagogy architect for a French learner.',
              'Build high-quality original lesson material from an audio transcript.',
              'Be precise, practical, and aligned with CEFR progression.',
              'Respond only with valid JSON.',
              '',
              buildPrompt(index, level, transcript),
            ].join('\n'),
          }],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 5200,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  ).catch((error) => {
    throw new AssimilGenerationError(error instanceof Error ? error.message : 'Gemini fetch failed');
  });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new AssimilGenerationError(`Gemini HTTP ${res.status}: ${preview.slice(0, 240)}`);
  }

  const data = await res.json<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>().catch(() => null);
  const raw = data ? extractGeminiText(data) : null;
  if (!raw) throw new AssimilGenerationError('Gemini response without message content');

  const parsed = extractJsonObject(raw) as AssimilLessonArtifact | null;
  if (!parsed) {
    throw new AssimilGenerationError(`Gemini JSON parse failed: ${raw.slice(0, 240)}`);
  }

  return parsed;
}

export async function generateAssimilArtifact(
  env: Env,
  index: number,
  level: AssimilLevel,
  transcript: string,
  options: {
    model?: string;
    provider?: AssimilGenerationProvider;
  } = {},
): Promise<AssimilLessonArtifact> {
  if (options.provider === 'gemini') {
    return generateAssimilArtifactWithGemini(env, index, level, transcript, options.model);
  }

  return generateAssimilArtifactWithDeepSeek(env, index, level, transcript);
}

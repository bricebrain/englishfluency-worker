import type { Env } from './types';
import type { AssimilLessonArtifact, AssimilLevel } from './assimilModel';

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

export async function generateAssimilArtifact(
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

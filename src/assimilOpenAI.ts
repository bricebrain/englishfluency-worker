import type { Env } from './types';
import type { WhisperTranscription } from './assimilRunpod';

export class OpenAITranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenAITranscriptionError';
  }
}

export async function transcribeWithOpenAI(
  env: Env,
  input: {
    audio: ArrayBuffer;
    filename: string;
    prompt?: string;
    model?: string;
  },
): Promise<WhisperTranscription> {
  const apiKey = await env.OPENAI_API_KEY.get().catch(() => null);
  if (!apiKey) throw new OpenAITranscriptionError('OPENAI_API_KEY manquant');

  const model = input.model ?? 'gpt-4o-transcribe';
  const form = new FormData();
  form.append('file', new File([input.audio], input.filename, { type: 'audio/mpeg' }));
  form.append('model', model);
  form.append('language', 'en');
  form.append('response_format', 'json');
  if (input.prompt) form.append('prompt', input.prompt);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => {
    throw new OpenAITranscriptionError(
      error instanceof Error ? error.message : 'OpenAI transcription fetch failed',
    );
  });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new OpenAITranscriptionError(`OpenAI transcription HTTP ${res.status}: ${preview.slice(0, 220)}`);
  }

  const data = await res.json<{ text?: string }>().catch(() => null);
  const text = data?.text?.trim();
  if (!text) throw new OpenAITranscriptionError('Transcription OpenAI vide');

  return {
    text,
    segments: [],
    model,
    language: 'en',
    languageProbability: 0,
    duration: 0,
    durationMs: 0,
  };
}

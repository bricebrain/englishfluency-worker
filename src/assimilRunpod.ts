import type { Env } from './types';

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface WhisperTranscription {
  text: string;
  segments: WhisperSegment[];
  model: string;
  language: string;
  languageProbability: number;
  duration: number;
  durationMs: number;
}

interface RunPodWhisperOutput {
  text?: string;
  segments?: WhisperSegment[];
  model?: string;
  language?: string;
  language_probability?: number;
  duration?: number;
  duration_ms?: number;
}

interface RunPodEnvelope {
  status?: string;
  error?: string;
  output?: {
    ok?: boolean;
    error?: string;
    output?: RunPodWhisperOutput;
  };
}

function normalizeRunPodOutput(data: RunPodEnvelope): RunPodWhisperOutput | null {
  if (data.status && data.status !== 'COMPLETED') return null;
  if (data.output?.ok === false) return null;
  return data.output?.output ?? null;
}

export async function transcribeWithRunPod(
  env: Env,
  input: {
    audioUrl: string;
    model?: string;
    initialPrompt?: string;
  },
): Promise<WhisperTranscription | null> {
  if (!env.RUNPOD_API_KEY || !env.RUNPOD_AI_ENDPOINT_ID) return null;

  const res = await fetch(`https://api.runpod.ai/v2/${env.RUNPOD_AI_ENDPOINT_ID}/runsync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        task: 'transcribe.whisper',
        audio_url: input.audioUrl,
        language: 'en',
        model: input.model,
        initial_prompt:
          input.initialPrompt ??
          'English audio lesson for French learners. Clear short educational sentences.',
      },
    }),
  }).catch(() => null);

  if (!res?.ok) return null;
  const data = await res.json<RunPodEnvelope>().catch(() => null);
  if (!data) return null;

  const output = normalizeRunPodOutput(data);
  const text = output?.text?.trim();
  if (!output || !text) return null;

  return {
    text,
    segments: Array.isArray(output.segments) ? output.segments : [],
    model: output.model ?? input.model ?? 'whisper',
    language: output.language ?? 'en',
    languageProbability: Number(output.language_probability ?? 0),
    duration: Number(output.duration ?? 0),
    durationMs: Number(output.duration_ms ?? 0),
  };
}

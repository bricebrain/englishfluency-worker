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

export class RunPodTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPodTranscriptionError';
  }
}

function normalizeRunPodOutput(data: RunPodEnvelope): RunPodWhisperOutput {
  if (data.error) throw new RunPodTranscriptionError(`RunPod: ${data.error}`);
  if (data.status && data.status !== 'COMPLETED') {
    throw new RunPodTranscriptionError(`RunPod status ${data.status}`);
  }
  if (data.output?.ok === false) {
    throw new RunPodTranscriptionError(data.output.error ?? 'RunPod worker returned ok=false');
  }
  if (!data.output?.output) {
    throw new RunPodTranscriptionError('RunPod response has no transcription output');
  }
  return data.output.output;
}

export function normalizeRunPodApiKey(rawKey: string): string {
  return rawKey
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/^RUNPOD_API_KEY\s*=\s*/i, '')
    .replace(/^Bearer\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function runPodHttpError(
  status: number,
  body: string,
  diagnostics: { endpointId: string; apiKeyLength: number },
): RunPodTranscriptionError {
  const preview = body.slice(0, 180);
  if (status === 401 || status === 403) {
    return new RunPodTranscriptionError(
      `RunPod HTTP ${status}: autorisation refusee. endpoint=${diagnostics.endpointId}, keyLength=${diagnostics.apiKeyLength}. Verifie que RUNPOD_API_KEY est la cle API brute du meme compte RunPod et que l'endpoint appartient a ce compte. ${preview}`,
    );
  }
  return new RunPodTranscriptionError(`RunPod HTTP ${status}: ${preview}`);
}

export async function transcribeWithRunPod(
  env: Env,
  input: {
    audioUrl: string;
    model?: string;
    initialPrompt?: string;
  },
): Promise<WhisperTranscription> {
  if (!env.RUNPOD_API_KEY) {
    throw new RunPodTranscriptionError('RUNPOD_API_KEY manquant sur englishfluency-worker');
  }
  if (!env.RUNPOD_AI_ENDPOINT_ID) {
    throw new RunPodTranscriptionError('RUNPOD_AI_ENDPOINT_ID manquant sur englishfluency-worker');
  }

  const runpodApiKey = normalizeRunPodApiKey(env.RUNPOD_API_KEY);
  const endpointId = env.RUNPOD_AI_ENDPOINT_ID.trim();
  const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/runsync`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runpodApiKey}`,
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
    signal: AbortSignal.timeout(180_000),
  }).catch((error) => {
    throw new RunPodTranscriptionError(error instanceof Error ? error.message : 'RunPod fetch failed');
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw runPodHttpError(res.status, text, {
      endpointId,
      apiKeyLength: runpodApiKey.length,
    });
  }
  const data = await res.json<RunPodEnvelope>().catch(() => null);
  if (!data) throw new RunPodTranscriptionError('RunPod JSON invalide');

  const output = normalizeRunPodOutput(data);
  const text = output?.text?.trim();
  if (!text) throw new RunPodTranscriptionError('Transcription vide');

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

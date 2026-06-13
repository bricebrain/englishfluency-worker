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
  id?: string;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchRunPodStatus(
  endpointId: string,
  apiKey: string,
  jobId: string,
): Promise<RunPodEnvelope> {
  const res = await fetch(`https://api.runpod.ai/v2/${endpointId}/status/${jobId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    throw new RunPodTranscriptionError(error instanceof Error ? error.message : 'RunPod status fetch failed');
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw runPodHttpError(res.status, text, {
      endpointId,
      apiKeyLength: apiKey.length,
    });
  }

  const data = await res.json<RunPodEnvelope>().catch(() => null);
  if (!data) throw new RunPodTranscriptionError('RunPod status JSON invalide');
  return data;
}

async function waitForRunPodCompletion(
  initialData: RunPodEnvelope,
  endpointId: string,
  apiKey: string,
): Promise<RunPodEnvelope> {
  let data = initialData;
  const queuedStatuses = new Set(['IN_QUEUE', 'IN_PROGRESS']);
  const terminalErrorStatuses = new Set(['FAILED', 'CANCELLED', 'TIMED_OUT']);

  for (let attempt = 0; attempt < 36; attempt += 1) {
    if (!data.status || data.status === 'COMPLETED') return data;
    if (terminalErrorStatuses.has(data.status)) {
      throw new RunPodTranscriptionError(`RunPod status ${data.status}: ${data.error ?? 'job failed'}`);
    }
    if (!queuedStatuses.has(data.status)) return data;
    if (!data.id) throw new RunPodTranscriptionError(`RunPod status ${data.status} sans job id`);

    await sleep(attempt < 6 ? 5_000 : 10_000);
    data = await fetchRunPodStatus(endpointId, apiKey, data.id);
  }

  throw new RunPodTranscriptionError(`RunPod transcription timeout: ${data.status ?? 'unknown'}`);
}

export async function transcribeWithRunPod(
  env: Env,
  input: {
    audioUrl?: string;
    audioBase64?: string;
    device?: string;
    computeType?: string;
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
  if (!input.audioUrl && !input.audioBase64) {
    throw new RunPodTranscriptionError('audioUrl ou audioBase64 requis pour RunPod');
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
        audio_base64: input.audioBase64,
        language: 'en',
        device: input.device,
        compute_type: input.computeType,
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
  const initialData = await res.json<RunPodEnvelope>().catch(() => null);
  if (!initialData) throw new RunPodTranscriptionError('RunPod JSON invalide');
  const data = await waitForRunPodCompletion(initialData, endpointId, runpodApiKey);
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

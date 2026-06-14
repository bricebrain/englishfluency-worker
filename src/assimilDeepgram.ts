import type { Env } from './types';
import type { WhisperSegment, WhisperTranscription } from './assimilRunpod';

export class DeepgramTranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepgramTranscriptionError';
  }
}

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
  punctuated_word?: string;
}

interface DeepgramUtterance {
  start: number;
  end: number;
  confidence?: number;
  transcript: string;
  speaker?: number;
  words?: DeepgramWord[];
}

interface DeepgramResponse {
  metadata?: { duration?: number; model_info?: Record<string, { name?: string }> };
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        confidence?: number;
        words?: DeepgramWord[];
      }>;
    }>;
    utterances?: DeepgramUtterance[];
  };
}

function speakerLabel(speaker: number | undefined): string {
  if (speaker === undefined || !Number.isFinite(speaker)) return 'speaker_0';
  return `speaker_${speaker}`;
}

/** Deepgram transcrit certains titres phonétiquement ("missus" → "Mrs"). On normalise. */
function normalizeSpokenTitles(text: string): string {
  return text
    .replace(/\bmiss(?:us|is)\b/gi, 'Mrs')
    .replace(/\bmister\b/gi, 'Mr');
}

/**
 * Deepgram Nova-3 : transcription fidèle (modèle ASR dédié, ne « résume » pas)
 * + diarisation native (speaker par segment) + ponctuation (question vs affirmation)
 * dans un seul appel. Renvoie le type WhisperTranscription déjà consommé par le pipeline.
 */
export async function transcribeWithDeepgram(
  env: Env,
  input: {
    audio: ArrayBuffer;
    mimeType?: string;
    model?: string;
    minSpeakers?: number;
    maxSpeakers?: number;
  },
): Promise<WhisperTranscription> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new DeepgramTranscriptionError('DEEPGRAM_API_KEY manquant');

  const model = input.model ?? 'nova-3';
  const params = new URLSearchParams({
    model,
    language: 'en',
    diarize: 'true',
    punctuate: 'true',
    smart_format: 'true',
    utterances: 'true',
  });

  const startedAt = Date.now();
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': input.mimeType ?? 'audio/mpeg',
    },
    body: input.audio,
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => {
    throw new DeepgramTranscriptionError(
      error instanceof Error ? error.message : 'Deepgram fetch failed',
    );
  });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new DeepgramTranscriptionError(`Deepgram HTTP ${res.status}: ${preview.slice(0, 220)}`);
  }

  const data = await res.json<DeepgramResponse>().catch(() => null);
  if (!data) throw new DeepgramTranscriptionError('Réponse Deepgram invalide');

  const alternative = data.results?.channels?.[0]?.alternatives?.[0];
  const utterances = data.results?.utterances ?? [];

  const rawText = alternative?.transcript?.trim()
    || utterances.map((u) => u.transcript).filter(Boolean).join(' ').trim();
  if (!rawText) throw new DeepgramTranscriptionError('Transcription Deepgram vide');
  const text = normalizeSpokenTitles(rawText);

  const segments: WhisperSegment[] = utterances.map((utterance) => ({
    start: utterance.start,
    end: utterance.end,
    text: normalizeSpokenTitles(utterance.transcript.trim()),
    speaker: speakerLabel(utterance.speaker),
    voice_profile: null,
    words: utterance.words?.map((word) => ({
      word: word.punctuated_word ?? word.word,
      start: word.start,
      end: word.end,
      probability: word.confidence,
    })),
  }));

  const speakerCount = new Set(
    segments.map((segment) => segment.speaker).filter(Boolean),
  ).size;

  return {
    text,
    segments,
    model,
    language: 'en',
    languageProbability: alternative?.confidence ?? 0,
    duration: data.metadata?.duration ?? 0,
    durationMs: Date.now() - startedAt,
    provider: 'deepgram',
    wordTimestamps: true,
    audioFeatures: false,
    diarization: {
      available: speakerCount > 0,
      reason: speakerCount > 0
        ? `Deepgram native diarization (${speakerCount} speakers)`
        : 'No speaker distinction returned by Deepgram',
    },
  };
}

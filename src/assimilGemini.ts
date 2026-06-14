import type { Env } from './types';
import type { WhisperTranscription } from './assimilRunpod';

export class GeminiAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiAudioError';
  }
}

interface GeminiAudioSegment {
  start: string;
  end?: string;
  textEn: string;
  textFr?: string;
  speakerLabel?: string;
  inferredGender?: 'female' | 'male' | 'unknown';
  tone?: string;
  emotion?: 'happy' | 'neutral' | 'calm' | 'stressed' | 'uncertain' | 'other';
  pace?: 'slow' | 'normal' | 'fast';
  pronunciationFocus?: string;
}

interface GeminiAudioResult {
  titleEn?: string;
  titleFr?: string;
  summaryFr?: string;
  transcriptEn?: string;
  transcriptFr?: string;
  language?: string;
  speakers?: Array<{
    label: string;
    inferredGender: 'female' | 'male' | 'unknown';
    roleGuess?: string;
    confidence?: number;
  }>;
  segments?: GeminiAudioSegment[];
  pedagogicalNotes?: Array<{
    topic: string;
    explanationFr: string;
  }>;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function extractGeminiText(data: {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}): string | null {
  return data.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text?.trim() ?? null;
}

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

function buildAssimilAudioPrompt(lessonCode: string): string {
  return [
    `Analyse cette leçon audio Assimil anglaise (${lessonCode}) pour une application d'apprentissage.`,
    '',
    'Objectif: produire une transcription exploitable pédagogiquement, pas seulement du texte brut.',
    '',
    'Contraintes importantes:',
    '- Fidélité prioritaire: ne supprime aucun mot entendu. Si une phrase est répétée dans l’audio, elle doit aussi apparaître dans "segments" à chaque occurrence.',
    '- L’audio peut contenir plusieurs parties: titre, leçon, pauses, exercice, correction/traduction. Conserve les titres, consignes, exercices et corrections dans l’ordre chronologique.',
    '- "transcriptEn" doit être la transcription complète et chronologique de tout ce qui est prononcé en anglais, pas une synthèse.',
    '- "segments" doit contenir les unités réellement prononcées, même si elles se répètent. Ne déduplique pas les segments.',
    '- Garde les phrases anglaises naturelles, mais n’ajoute pas de mots non entendus.',
    '- Si plusieurs voix existent, distingue les locuteurs au mieux avec speakerLabel.',
    '- inferredGender est seulement une estimation audio très incertaine: utilise "unknown" par défaut, sauf si la voix est absolument évidente.',
    '- Ne t’appuie pas sur le rôle du dialogue pour deviner le genre. Une voix féminine peut lire un rôle masculin, et inversement.',
    '- Les timestamps peuvent être approximatifs mais doivent rester utiles pour naviguer phrase par phrase.',
    '- Les notes pédagogiques doivent expliquer ce qui aide un francophone.',
    '',
    'Retourne uniquement un JSON valide avec ce schéma:',
    '{',
    '  "titleEn": "short English title",',
    '  "titleFr": "titre français court",',
    '  "summaryFr": "résumé pédagogique en français",',
    '  "transcriptEn": "transcription anglaise complète, chronologique, non dédupliquée",',
    '  "transcriptFr": "traduction française naturelle",',
    '  "language": "en",',
    '  "speakers": [{ "label": "speaker_1", "inferredGender": "female|male|unknown", "roleGuess": "narrator|learner|dialogue", "confidence": 0.0 }],',
    '  "segments": [{',
    '    "start": "MM:SS",',
    '    "end": "MM:SS",',
    '    "textEn": "exact spoken English segment",',
    '    "textFr": "French translation",',
    '    "speakerLabel": "speaker_1",',
    '    "inferredGender": "female|male|unknown",',
    '    "tone": "short French description",',
    '    "emotion": "happy|neutral|calm|stressed|uncertain|other",',
    '    "pace": "slow|normal|fast",',
    '    "pronunciationFocus": "conseil court pour francophone"',
    '  }],',
    '  "pedagogicalNotes": [{ "topic": "point clé", "explanationFr": "explication concise" }]',
    '}',
  ].join('\n');
}

function segmentTimeToSeconds(raw: string | undefined): number {
  if (!raw) return 0;
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function normalizeGeminiResult(
  result: GeminiAudioResult,
  model: string,
  durationMs: number,
): WhisperTranscription {
  const transcript = result.transcriptEn?.trim()
    || result.segments?.map((segment) => segment.textEn).filter(Boolean).join('\n')
    || '';

  return {
    text: transcript,
    segments: (result.segments ?? []).map((segment) => ({
      start: segmentTimeToSeconds(segment.start),
      end: segmentTimeToSeconds(segment.end),
      text: segment.textEn,
      speaker: segment.speakerLabel ?? null,
      voice_profile: null,
      audio_features: {
        energy: segment.emotion === 'stressed' ? 'high' : 'medium',
        words_per_minute: segment.pace === 'fast' ? 170 : segment.pace === 'slow' ? 90 : 125,
      },
    })),
    model,
    language: result.language ?? 'en',
    languageProbability: 0,
    duration: 0,
    durationMs,
    provider: 'gemini',
    audioFeatures: true,
    diarization: {
      available: Boolean(result.speakers?.length),
      reason: result.speakers?.length
        ? 'Gemini prompt-based speaker inference'
        : 'No speaker distinction returned by Gemini',
    },
  };
}

export async function transcribeWithGeminiAudio(
  env: Env,
  input: {
    audio: ArrayBuffer;
    filename: string;
    mimeType?: string;
    lessonCode: string;
    model?: string;
  },
): Promise<{ transcription: WhisperTranscription; analysis: GeminiAudioResult }> {
  const apiKey = await env.GEMINI_API_KEY.get().catch(() => null);
  if (!apiKey) throw new GeminiAudioError('GEMINI_API_KEY manquant');

  const model = input.model ?? 'gemini-3.5-flash';
  const mimeType = input.mimeType ?? 'audio/mpeg';
  if (input.audio.byteLength > 19_000_000) {
    throw new GeminiAudioError('Audio trop volumineux pour inline Gemini; utiliser Files API');
  }

  const startedAt = Date.now();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: toBase64(input.audio) } },
            { text: buildAssimilAudioPrompt(input.lessonCode) },
          ],
        }],
        generationConfig: {
          temperature: 0.15,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  ).catch((error) => {
    throw new GeminiAudioError(error instanceof Error ? error.message : 'Gemini audio fetch failed');
  });

  if (!res.ok) {
    const preview = await res.text().catch(() => '');
    throw new GeminiAudioError(`Gemini audio HTTP ${res.status}: ${preview.slice(0, 260)}`);
  }

  const data = await res.json<{
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  }>().catch(() => null);
  const rawText = data ? extractGeminiText(data) : null;
  if (!rawText) throw new GeminiAudioError('Réponse Gemini audio vide');

  const analysis = safeParseJson<GeminiAudioResult>(rawText);
  if (!analysis) throw new GeminiAudioError(`JSON Gemini audio invalide: ${rawText.slice(0, 260)}`);

  const transcription = normalizeGeminiResult(analysis, model, Date.now() - startedAt);
  if (!transcription.text.trim()) throw new GeminiAudioError('Transcription Gemini vide');

  return { transcription, analysis };
}

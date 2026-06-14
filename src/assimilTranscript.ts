const LESSON_MARKER_PATTERN = /^([a-z]+|\d+)(st|nd|rd|th)?\s+lesson\.?$/i;
const EXERCISE_MARKER_PATTERN = /^exercise\s+([a-z]+|\d+)\.?\s*(translate|fill in the missing words)?\.?$/i;
const DRILL_LABEL_PATTERN = /^(translate|fill in the missing words)\.?$/i;

function normalizeForDedup(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitTranscriptLines(raw: string): string[] {
  const normalized = raw
    .replace(/\r/g, '\n')
    .replace(/\bMrs\./g, 'Mrs')
    .replace(/\bMr\./g, 'Mr')
    .replace(/\bMs\./g, 'Ms')
    .replace(/\bDr\./g, 'Dr');

  return normalized
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function cleanAssimilTranscript(raw: string): string {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const line of splitTranscriptLines(raw)) {
    if (
      LESSON_MARKER_PATTERN.test(line) ||
      EXERCISE_MARKER_PATTERN.test(line) ||
      DRILL_LABEL_PATTERN.test(line)
    ) continue;

    const key = normalizeForDedup(line);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    cleaned.push(line);
  }

  return cleaned.join('\n\n').trim() || raw.trim();
}

export function preserveAssimilTranscript(raw: string): string {
  return splitTranscriptLines(raw).join('\n\n').trim() || raw.trim();
}

export type DialogueGender = 'female' | 'male' | 'unknown';

export type DialogueEmotion =
  | 'happy'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'anxious'
  | 'calm'
  | 'neutral'
  | 'other';

export interface DialogueLine {
  speakerLabel: string;
  speakerNumber: number;
  gender: DialogueGender;
  text: string;
  /** Traduction française de la réplique (remplie lors de la préparation). */
  textFr: string;
  isQuestion: boolean;
  /** Émotion perçue à l'oral (joyeux, triste, etc.). */
  emotion: DialogueEmotion;
  /** Description courte du ton en français (ex. "enjoué et poli"). */
  tone: string;
  start: number;
  end: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    probability?: number;
  }>;
}

export interface DialogueAnnotation {
  emotion: DialogueEmotion;
  tone: string;
}

interface DiarizedSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  words?: DialogueLine['words'];
}

function genderLabelFr(gender: DialogueGender): string {
  if (gender === 'female') return 'femme';
  if (gender === 'male') return 'homme';
  return 'voix inconnue';
}

const EMOTION_LABELS_FR: Record<DialogueEmotion, string> = {
  happy: 'joyeux',
  sad: 'triste',
  angry: 'agacé',
  surprised: 'surpris',
  anxious: 'inquiet',
  calm: 'calme',
  neutral: 'neutre',
  other: 'autre',
};

function emotionLabelFr(emotion: DialogueEmotion): string {
  return EMOTION_LABELS_FR[emotion] ?? 'neutre';
}

function speakerNumberFromLabel(label: string | null | undefined): number {
  const match = label?.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

/**
 * Reconstruit le dialogue de la SEULE 1ʳᵉ lecture à partir des segments diarisés.
 * - tronque à partir de la section exercice/traduction (marqueur "Exercise" / "Translate") ;
 * - retire les marqueurs de leçon ;
 * - déduplique par contenu en gardant la 1ʳᵉ occurrence → supprime le shadowing/la répétition ;
 * - étiquette chaque ligne Speaker N (homme/femme) et détecte question vs affirmation.
 */
export function buildAssimilDialogue(
  segments: DiarizedSegment[],
  genderBySpeaker: Record<string, DialogueGender> = {},
): DialogueLine[] {
  const seen = new Set<string>();
  const lines: DialogueLine[] = [];

  for (const segment of segments) {
    const text = segment.text?.trim();
    if (!text) continue;

    // À partir de la première consigne d'exercice/traduction, tout le reste est hors 1ʳᵉ lecture.
    if (EXERCISE_MARKER_PATTERN.test(text) || DRILL_LABEL_PATTERN.test(text)) break;
    if (LESSON_MARKER_PATTERN.test(text)) continue;

    const key = normalizeForDedup(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const speakerLabel = segment.speaker ?? 'speaker_0';
    lines.push({
      speakerLabel,
      speakerNumber: speakerNumberFromLabel(speakerLabel) + 1,
      gender: genderBySpeaker[speakerLabel] ?? 'unknown',
      text,
      textFr: '',
      isQuestion: /\?\s*$/.test(text),
      emotion: 'neutral',
      tone: '',
      start: segment.start,
      end: segment.end,
      words: segment.words,
    });
  }

  return lines;
}

/**
 * Applique sur les lignes du dialogue le genre par locuteur et les annotations
 * d'émotion/ton (indexées dans le même ordre que les lignes). Tout est optionnel :
 * les valeurs absentes laissent les défauts (`unknown` / `neutral`).
 */
export function applyDialogueAnalysis(
  lines: DialogueLine[],
  input: {
    genderBySpeaker?: Record<string, DialogueGender>;
    annotations?: DialogueAnnotation[];
  },
): DialogueLine[] {
  return lines.map((line, index) => {
    const annotation = input.annotations?.[index];
    return {
      ...line,
      gender: input.genderBySpeaker?.[line.speakerLabel] ?? line.gender,
      emotion: annotation?.emotion ?? line.emotion,
      tone: annotation?.tone ?? line.tone,
    };
  });
}

/** Rendu lisible: "Speaker 1 (femme, joyeux): It's important." */
export function formatAssimilDialogue(lines: DialogueLine[]): string {
  return lines
    .map((line) => {
      const meta = [genderLabelFr(line.gender), emotionLabelFr(line.emotion)].join(', ');
      return `Speaker ${line.speakerNumber} (${meta}): ${line.text}`;
    })
    .join('\n')
    .trim();
}

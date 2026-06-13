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

import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import {
  ENRICHMENT_JOIN_SQL,
  ENRICHMENT_SELECT_SQL,
  withEnrichment,
  type EnrichmentColumns,
  type VocabularyEnrichmentDto,
} from './vocabularyEnrichmentMapper';
import { formatLesson, safeJsonParse, type AssimilLessonRow } from './assimilModel';
import {
  DUE_WORD_LEVEL_FILTER_SQL,
  NEW_WORD_LEVEL_FILTER_SQL,
  loadLevelFloorRank,
  rankNewWordsByPriority,
} from './srs';

const SCHEMA_VERSION = 4;

interface SessionWordRow {
  id: string;
  mot: string;
  type: string | null;
  niveau: string;
  traduction: string | null;
  ipa_uk: string | null;
  ipa_us: string | null;
  exemple_en: string | null;
  exemple_fr: string | null;
  examples: string;
  audio_uk: string | null;
  audio_us: string | null;
  prochaine_revision: string;
  intervalle: number;
  facilite: number;
  repetitions: number;
  derniere_revision: string | null;
  seen_count: number;
  success_count: number;
  almost_count: number;
  fail_count: number;
  level: number;
  status: string;
  review_history: string;
}

interface WordRow {
  id: string;
  mot: string;
  type: string | null;
  niveau: string;
  traduction: string | null;
  ipa_uk: string | null;
  ipa_us: string | null;
  exemple_en: string | null;
  exemple_fr: string | null;
  examples: string;
  audio_uk: string | null;
  audio_us: string | null;
}

interface PreparedWord extends Omit<SessionWordRow, 'examples' | 'review_history'> {
  examples: Array<{ en: string; fr: string }>;
  review_history: unknown[];
  enrichment?: VocabularyEnrichmentDto | null;
}

interface LearningEventSignalRow {
  payload: string;
  score: number | null;
}

interface CardRow {
  word_id: string;
  example_en: string;
  lemma: string;
  target_pos: string;
  verb_form_label: string | null;
  expected_answer: string;
  sentence_with_gap: string;
  sentence_full: string;
  translation_fr: string;
  word_traduction_fr: string | null;
  grammar_hint: string;
  input_placeholder: string;
  source: string;
  schema_version: number;
}

interface PreparedCard {
  wordId: string;
  exampleEn: string;
  lemma: string;
  targetPos: 'verb' | 'other';
  verbFormLabel: string | null;
  expectedAnswer: string;
  sentenceWithGap: string;
  sentenceFull: string;
  translationFr: string;
  wordTraductionFr?: string;
  grammarHint: string;
  inputPlaceholder: string;
  source: 'remote' | 'local';
  schemaVersion: number;
  qualityReasons?: string[];
  qualityScore?: number;
  qualityStatus?: 'valid' | 'rebuilt' | 'needs_regeneration';
  sourceLesson?: AssimilCardSource;
  nativeAudio?: AssimilNativeAudio;
}

interface AssimilCardSource {
  provider: 'assimil';
  lessonIndex: number;
  lessonCode: string;
  titleEn: string | null;
  titleFr: string | null;
  level: string;
  recycled: boolean;
}

interface AssimilNativeAudio {
  audioUrl: string;
  start: number;
  end: number;
  speakerLabel: string;
  speakerNumber: number;
  gender: 'female' | 'male' | 'unknown';
  emotion: string;
  tone: string;
  text: string;
  textFr: string;
}

interface CardQuality {
  isValid: boolean;
  needsRegeneration: boolean;
  reasons: string[];
  score: number;
  sourceQuality: 'local_validated' | 'remote_validated' | 'remote_rejected';
}

interface AssimilDialogueLine {
  speakerLabel?: string;
  speakerNumber?: number;
  gender?: 'female' | 'male' | 'unknown';
  text?: string;
  textFr?: string;
  emotion?: string;
  tone?: string;
  start?: number;
  end?: number;
}

const SELECT_WORD = `
  json_extract(w.examples, '$[0].en') AS exemple_en,
  json_extract(w.examples, '$[0].fr') AS exemple_fr,
  w.examples, w.audio_uk, w.audio_us`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function extractRecentSignals(payload: Record<string, unknown>): string[] {
  const signals = Array.isArray(payload.linguisticSignals)
    ? payload.linguisticSignals.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const errorCategory = typeof payload.errorCategory === 'string' ? payload.errorCategory : '';
  const correctionMode = typeof payload.correctionMode === 'string' ? payload.correctionMode : '';

  return [...new Set([
    ...signals,
    errorCategory === 'none' ? '' : errorCategory,
    correctionMode === 'exact' ? '' : correctionMode,
  ].filter(Boolean))];
}

async function loadRecentWeaknessSignals(env: Env, profileId: string): Promise<string[]> {
  const result = await env.DB.prepare(`
    SELECT payload, score
    FROM learning_events
    WHERE profile_id = ?
      AND event_type = 'review_word'
      AND module IN ('lingvist', 'review')
      AND occurred_at >= datetime('now', '-14 days')
    ORDER BY occurred_at DESC
    LIMIT 60
  `).bind(profileId).all<LearningEventSignalRow>();

  const counts = new Map<string, number>();

  for (const row of result.results) {
    if ((row.score ?? 1) > 0.72) continue;
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    for (const signal of extractRecentSignals(payload)) {
      counts.set(signal, (counts.get(signal) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([signal]) => signal);
}

function hydrateExistingWord(joined: SessionWordRow & EnrichmentColumns): PreparedWord {
  const row = withEnrichment(joined);
  return {
    ...row,
    examples: parseJson<Array<{ en: string; fr: string }>>(row.examples, []),
    review_history: parseJson<unknown[]>(row.review_history, []),
  };
}

function hydrateNewWord(joined: WordRow & EnrichmentColumns, now: string): PreparedWord {
  const row = withEnrichment(joined);
  return {
    ...row,
    examples: parseJson<Array<{ en: string; fr: string }>>(row.examples, []),
    prochaine_revision: now,
    intervalle: 0,
    facilite: 2.5,
    repetitions: 0,
    derniere_revision: null,
    seen_count: 0,
    success_count: 0,
    almost_count: 0,
    fail_count: 0,
    level: 0,
    status: 'new',
    review_history: [],
  };
}

/** Traduction principale corrigée par l'atelier Vocabulaire, si publiée. */
function enrichedTranslation(word: PreparedWord | undefined): string {
  return cleanText(word?.enrichment?.primaryTranslation);
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\w\s']/g, '')
    .replace(/\s+/g, ' ');
}

function normalizedContains(haystack: string, needle: string): boolean {
  const normalizedHaystack = normalize(haystack);
  const normalizedNeedle = normalize(needle);
  return Boolean(normalizedHaystack && normalizedNeedle && normalizedHaystack.includes(normalizedNeedle));
}

function parseLessonIndexFromCode(code: string): number | null {
  const match = code.match(/L(\d{3})/i);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : null;
}

function extractAssimilLessonIndex(word: PreparedWord): number | null {
  const idMatch = word.id.match(/^assim_l(\d{3})_/i);
  if (idMatch) return Number(idMatch[1]);

  for (const entry of word.review_history) {
    if (!entry || typeof entry !== 'object') continue;
    const feedback = (entry as { aiFeedback?: unknown }).aiFeedback;
    if (typeof feedback !== 'string') continue;
    const index = parseLessonIndexFromCode(feedback);
    if (index !== null) return index;
  }

  return null;
}

function parseAssimilDialogue(row: AssimilLessonRow | null): AssimilDialogueLine[] {
  if (!row?.audio_json) return [];
  const audio = safeJsonParse<{ dialogue?: AssimilDialogueLine[] }>(row.audio_json, {});
  return Array.isArray(audio.dialogue) ? audio.dialogue : [];
}

function scoreDialogueLine(line: AssimilDialogueLine, card: PreparedCard): number {
  const text = cleanText(line.text);
  if (!text) return 0;

  let score = 0;
  if (normalizedContains(text, card.expectedAnswer)) score += 60;
  if (normalizedContains(text, card.lemma)) score += 50;
  if (normalizedContains(card.sentenceFull, text)) score += 35;
  if (normalizedContains(text, card.sentenceFull)) score += 35;

  const cardWords = new Set(normalize(card.sentenceFull).split(' ').filter(Boolean));
  const lineWords = normalize(text).split(' ').filter(Boolean);
  const overlap = lineWords.filter((word) => cardWords.has(word)).length;
  score += Math.min(30, overlap * 4);

  if (Number.isFinite(line.start) && Number.isFinite(line.end)) score += 8;
  return score;
}

function findNativeAudio(row: AssimilLessonRow | null, card: PreparedCard): AssimilNativeAudio | undefined {
  const dialogue = parseAssimilDialogue(row);
  if (!dialogue.length) return undefined;

  const best = [...dialogue]
    .map((line) => ({ line, score: scoreDialogueLine(line, card) }))
    .filter((candidate) => candidate.score >= 55)
    .sort((a, b) => b.score - a.score)[0]?.line;

  if (!best || !Number.isFinite(best.start) || !Number.isFinite(best.end)) return undefined;

  return {
    audioUrl: formatLesson(row?.lesson_index ?? 0).audioUrl,
    start: Number(best.start),
    end: Number(best.end),
    speakerLabel: best.speakerLabel ?? 'speaker_0',
    speakerNumber: Number(best.speakerNumber ?? 1),
    gender: best.gender ?? 'unknown',
    emotion: best.emotion ?? 'neutral',
    tone: best.tone ?? '',
    text: cleanText(best.text),
    textFr: cleanText(best.textFr),
  };
}

function pickBestExample(word: PreparedWord): { en: string; fr: string } {
  const lemma = cleanText(word.mot).toLowerCase();
  const examples = word.examples.filter((example) => cleanText(example.en));
  const containingLemma = examples.find((example) => {
    const sentence = normalize(example.en);
    return new RegExp(`\\b${escapeRegex(lemma)}\\b`, 'i').test(sentence);
  });

  if (containingLemma) return containingLemma;
  if (examples[0]) return examples[0];

  return {
    en: cleanText(word.exemple_en),
    fr: cleanText(word.exemple_fr),
  };
}

function buildLocalPreparedCard(word: PreparedWord): PreparedCard {
  const lemma = cleanText(word.mot);
  const bestExample = pickBestExample(word);
  const sentenceFull =
    cleanText(bestExample.en) ||
    cleanText(word.exemple_en) ||
    `I use ${lemma} in a simple English sentence.`;
  const translationFr =
    cleanText(bestExample.fr) ||
    cleanText(word.exemple_fr) ||
    (word.traduction ? `Traduction: ${word.traduction}` : 'Traduction indisponible.');
  const answer = pickAnswer(lemma, sentenceFull);
  const targetPos = isVerbLike(word.type) ? 'verb' : 'other';

  return {
    wordId: word.id,
    exampleEn: cleanText(bestExample.en) || cleanText(word.exemple_en) || sentenceFull,
    lemma,
    targetPos,
    verbFormLabel: targetPos === 'verb' ? inferVerbLabel(sentenceFull, answer) : null,
    expectedAnswer: answer,
    sentenceWithGap: buildGap(sentenceFull, answer),
    sentenceFull,
    translationFr,
    wordTraductionFr: enrichedTranslation(word) || cleanText(word.traduction) || '',
    grammarHint: buildSafeGrammarHint(word, targetPos, targetPos === 'verb' ? inferVerbLabel(sentenceFull, answer) : null),
    inputPlaceholder: targetPos === 'verb' ? 'Ecris la bonne forme verbale' : 'Ecris le mot manquant',
    source: 'local',
    schemaVersion: SCHEMA_VERSION,
    qualityReasons: [],
    qualityScore: 0.72,
    qualityStatus: 'rebuilt',
  };
}

function isVerbLike(type: string | null): boolean {
  const lower = (type ?? '').toLowerCase();
  return /(^|[^a-z])v\.?($|[^a-z])/.test(lower) || /\bverb\b/.test(lower) || /\bmodal\b/.test(lower);
}

function isNounLike(type: string | null): boolean {
  const lower = (type ?? '').toLowerCase();
  return /\bnoun\b|\bn\.?\b/.test(lower);
}

function isPrepositionLike(type: string | null): boolean {
  return /\bprep\b|\bpreposition\b/i.test(type ?? '');
}

function wordMatchesWeakness(word: PreparedWord, signals: string[]): boolean {
  if (!signals.length) return false;

  if (isVerbLike(word.type) && signals.some((signal) => ['agreement', 'tense', 'verb_form'].includes(signal))) {
    return true;
  }

  if (isNounLike(word.type) && signals.some((signal) => ['articles', 'plurality'].includes(signal))) {
    return true;
  }

  if (isPrepositionLike(word.type) && signals.includes('prepositions')) {
    return true;
  }

  if (signals.some((signal) => ['collocations', 'lexical_choice', 'slow_recall'].includes(signal))) {
    return true;
  }

  return false;
}

function isAssimilWord(word: PreparedWord): boolean {
  return word.id.startsWith('assim_');
}

function hasAssimilRecycleHistory(word: PreparedWord): boolean {
  return word.review_history.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const result = (entry as { result?: unknown }).result;
    const aiFeedback = (entry as { aiFeedback?: unknown }).aiFeedback;
    return result === 'assim_recycled'
      || (typeof aiFeedback === 'string' && aiFeedback.toLowerCase().includes('recycl'));
  });
}

function rankWordForWeakness(word: PreparedWord, signals: string[]): number {
  let score = 0;
  if (isAssimilWord(word)) score += 35;
  if (hasAssimilRecycleHistory(word)) score += 35;
  if (isAssimilWord(word) && word.repetitions <= 2) score += 5;
  if (wordMatchesWeakness(word, signals)) score += 20;
  score += (word.fail_count ?? 0) * 5;
  score += (word.almost_count ?? 0) * 2;
  score -= (word.success_count ?? 0) * 0.25;
  if (word.status === 'learning') score += 2;
  if (word.repetitions === 0) score += 1;
  return score;
}

function orderWordsForWeakness<T extends PreparedWord>(words: T[], signals: string[], limit: number): T[] {
  const hasAssimilWords = words.some(isAssimilWord);
  if (!signals.length && !hasAssimilWords) return words.slice(0, limit);

  return [...words]
    .sort((a, b) => {
      const scoreDiff = rankWordForWeakness(b, signals) - rankWordForWeakness(a, signals);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.prochaine_revision).localeCompare(String(b.prochaine_revision));
    })
    .slice(0, limit);
}

function pickAnswer(lemma: string, sentenceFull: string): string {
  const tokens = sentenceFull.match(/[A-Za-z']+/g) ?? [];
  const lowerLemma = lemma.toLowerCase();
  return tokens.find((token) => token.toLowerCase() === lowerLemma) ?? lemma;
}

function inferVerbLabel(sentenceFull: string, answer: string): string {
  const lowerAnswer = answer.toLowerCase();
  const tokens = (sentenceFull.match(/[A-Za-z']+/g) ?? []).map((token) => token.toLowerCase());
  const index = tokens.findIndex((token) => token === lowerAnswer);
  const prev = index > 0 ? tokens[index - 1] : '';
  const infinitiveMarkers = new Set(['to', 'can', 'could', 'may', 'might', 'must', 'should', 'would', 'will']);

  if (lowerAnswer.endsWith('ing')) return 'participe present';
  if (lowerAnswer.endsWith('ed')) return 'preterit ou participe passe';
  if (infinitiveMarkers.has(prev)) return 'base verbale';
  if (lowerAnswer.endsWith('s')) return 'present simple 3e personne';
  return 'base verbale';
}

function buildSafeGrammarHint(
  word: PreparedWord,
  targetPos: 'verb' | 'other',
  verbFormLabel: string | null,
): string {
  const translation = cleanText(word.traduction);
  const meaning = translation ? ` Sens: ${translation}.` : '';

  if (targetPos === 'verb') {
    const form = verbFormLabel ? ` Forme attendue: ${verbFormLabel}.` : '';
    return `Cible: verbe.${meaning}${form} Observe le contexte avant et apres le trou.`;
  }

  return `Cible: mot lexical.${meaning} Complete avec le mot le plus naturel dans le contexte.`;
}

function isUnsafeVerbLabel(label: string | null): boolean {
  if (!label) return false;
  return /-|→|irrégulier|irregulier|mot cible|lemma|answer|choisir|choose|chosen/i.test(label);
}

function safeVerbLabel(card: PreparedCard): string {
  if (card.verbFormLabel && !isUnsafeVerbLabel(card.verbFormLabel)) {
    return card.verbFormLabel;
  }

  return inferVerbLabel(card.sentenceFull, card.expectedAnswer);
}

function sanitizeCardHint(word: PreparedWord, card: PreparedCard): PreparedCard {
  const expectedTargetPos = isVerbLike(word.type) ? 'verb' : 'other';
  const expectedVerbForm = expectedTargetPos === 'verb'
    ? safeVerbLabel(card)
    : null;

  return {
    ...card,
    targetPos: expectedTargetPos,
    verbFormLabel: expectedVerbForm,
    grammarHint: buildSafeGrammarHint(word, expectedTargetPos, expectedVerbForm),
    inputPlaceholder: expectedTargetPos === 'verb' ? 'Ecris la bonne forme verbale' : 'Ecris le mot manquant',
  };
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function isArtificialSentence(sentence: string, word: PreparedWord): boolean {
  const normalized = normalize(sentence);
  const lemma = normalize(word.mot);

  const patterns = [
    /\bher explanation was clear and\b/i,
    /\bit was a .* decision for the team\b/i,
    /\bi use .* in a simple english sentence\b/i,
    /\bthis is a clear sentence\b/i,
    /\btry adding .* to make your sentence more precise\b/i,
  ];

  if (patterns.some((pattern) => pattern.test(sentence))) return true;
  if (normalized === `i use ${lemma} in a simple english sentence`) return true;

  return false;
}

function hasTranslationSignal(card: PreparedCard, word: PreparedWord): boolean {
  const translation = normalize(word.traduction ?? '');
  if (!translation) return true;
  const cardTranslation = normalize(card.translationFr);
  return translation
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .some((token) => cardTranslation.includes(token));
}

function qualityScoreFromReasons(reasons: string[], source: PreparedCard['source']): number {
  const critical = new Set([
    'answer_not_in_sentence',
    'full_sentence_contains_gap',
    'missing_answer',
    'missing_gap',
    'missing_sentence',
    'target_pos_should_be_other',
    'target_pos_should_be_verb',
  ]);
  const penalty = reasons.reduce((sum, reason) => sum + (critical.has(reason) ? 0.28 : 0.12), 0);
  const sourceBonus = source === 'remote' ? 0.05 : 0;
  return Math.max(0, Math.min(1, 0.92 + sourceBonus - penalty));
}

function missingWordQuality(): CardQuality {
  return {
    isValid: false,
    needsRegeneration: true,
    reasons: ['word_missing'],
    score: 0,
    sourceQuality: 'remote_rejected',
  };
}

function buildGap(sentenceFull: string, answer: string): string {
  const pattern = new RegExp(`\\b${escapeRegex(answer)}\\b`, 'i');
  if (pattern.test(sentenceFull)) return sentenceFull.replace(pattern, '____');
  return `${sentenceFull} ____`;
}

function serializeCard(row: CardRow): PreparedCard {
  return {
    wordId: row.word_id,
    exampleEn: row.example_en,
    lemma: row.lemma,
    targetPos: row.target_pos === 'verb' ? 'verb' : 'other',
    verbFormLabel: row.verb_form_label,
    expectedAnswer: row.expected_answer,
    sentenceWithGap: row.sentence_with_gap,
    sentenceFull: row.sentence_full,
    translationFr: row.translation_fr,
    wordTraductionFr: row.word_traduction_fr ?? '',
    grammarHint: row.grammar_hint,
    inputPlaceholder: row.input_placeholder,
    source: row.source === 'remote' ? 'remote' : 'local',
    schemaVersion: row.schema_version,
  };
}

async function loadAssimilLessonRowsForWords(
  env: Env,
  words: PreparedWord[],
): Promise<Map<number, AssimilLessonRow>> {
  const indexes = [...new Set(
    words.map(extractAssimilLessonIndex).filter((index): index is number => index !== null),
  )];
  if (!indexes.length) return new Map();

  const placeholders = indexes.map(() => '?').join(', ');
  const result = await env.DB.prepare(`
    SELECT * FROM assimil_lessons
    WHERE lesson_index IN (${placeholders})
  `).bind(...indexes).all<AssimilLessonRow>();

  return new Map(result.results.map((row) => [row.lesson_index, row]));
}

function attachAssimilMetadata(
  word: PreparedWord,
  card: PreparedCard,
  lessonsByIndex: Map<number, AssimilLessonRow>,
): PreparedCard {
  const lessonIndex = extractAssimilLessonIndex(word);
  if (lessonIndex === null) return card;

  const base = formatLesson(lessonIndex);
  const row = lessonsByIndex.get(lessonIndex) ?? null;
  return {
    ...card,
    sourceLesson: {
      provider: 'assimil',
      lessonIndex,
      lessonCode: base.code,
      titleEn: row?.title_en ?? null,
      titleFr: row?.title_fr ?? null,
      level: row?.level ?? base.level,
      recycled: hasAssimilRecycleHistory(word),
    },
    nativeAudio: findNativeAudio(row, card),
  };
}

function assessCardQuality(word: PreparedWord, card: PreparedCard): CardQuality {
  const reasons: string[] = [];
  const expectedTargetPos = isVerbLike(word.type) ? 'verb' : 'other';
  const normalizedSentence = normalize(card.sentenceFull);
  const normalizedAnswer = normalize(card.expectedAnswer);
  const normalizedLemma = normalize(word.mot);

  if (card.schemaVersion !== SCHEMA_VERSION) reasons.push('schema_version_mismatch');
  if (!card.sentenceWithGap.includes('____')) reasons.push('missing_gap');
  if (!normalizedAnswer) reasons.push('missing_answer');
  if (!normalizedSentence) reasons.push('missing_sentence');
  if (normalizedSentence.includes('____')) reasons.push('full_sentence_contains_gap');
  if (!new RegExp(`\\b${escapeRegex(normalizedAnswer)}\\b`, 'i').test(normalizedSentence)) {
    reasons.push('answer_not_in_sentence');
  }
  if (card.targetPos !== expectedTargetPos) {
    reasons.push(`target_pos_should_be_${expectedTargetPos}`);
  }
  if (expectedTargetPos === 'verb' && !card.verbFormLabel) {
    reasons.push('missing_verb_form_label');
  }
  if (expectedTargetPos === 'other' && card.verbFormLabel) {
    reasons.push('unexpected_verb_form_label');
  }
  if (normalizedAnswer !== normalizedLemma && expectedTargetPos === 'other') {
    reasons.push('lexical_answer_differs_from_lemma');
  }
  if (/\b(clear and afraid|simple and afraid|natural and afraid)\b/i.test(card.sentenceFull)) {
    reasons.push('unnatural_known_pattern');
  }
  if (isArtificialSentence(card.sentenceFull, word)) reasons.push('artificial_sentence');
  if (wordCount(card.sentenceFull) < 3) reasons.push('sentence_too_short');
  if (wordCount(card.sentenceFull) > 22) reasons.push('sentence_too_long');
  if (!hasTranslationSignal(card, word)) reasons.push('translation_mismatch');

  const score = qualityScoreFromReasons(reasons, card.source);
  const needsRegeneration = reasons.some((reason) => [
    'answer_not_in_sentence',
    'artificial_sentence',
    'full_sentence_contains_gap',
    'lexical_answer_differs_from_lemma',
    'target_pos_should_be_other',
    'target_pos_should_be_verb',
    'unnatural_known_pattern',
  ].includes(reason));
  const isValid = reasons.length === 0 || (!needsRegeneration && score >= 0.7);

  return {
    isValid,
    needsRegeneration,
    reasons,
    score,
    sourceQuality: card.source === 'remote' && needsRegeneration
      ? 'remote_rejected'
      : card.source === 'remote'
        ? 'remote_validated'
        : 'local_validated',
  };
}

function upsertCardStatement(env: Env, profileId: string, card: PreparedCard): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO lingvist_cards (
      id, profile_id, word_id, example_en, lemma, target_pos, verb_form_label,
      expected_answer, sentence_with_gap, sentence_full, translation_fr,
      word_traduction_fr, grammar_hint, input_placeholder, source, schema_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      example_en=excluded.example_en, lemma=excluded.lemma,
      target_pos=excluded.target_pos, verb_form_label=excluded.verb_form_label,
      expected_answer=excluded.expected_answer, sentence_with_gap=excluded.sentence_with_gap,
      sentence_full=excluded.sentence_full, translation_fr=excluded.translation_fr,
      word_traduction_fr=excluded.word_traduction_fr,
      grammar_hint=excluded.grammar_hint, input_placeholder=excluded.input_placeholder,
      source=excluded.source, schema_version=excluded.schema_version,
      updated_at=datetime('now')
  `).bind(
    `${profileId}_${card.wordId}`,
    profileId,
    card.wordId,
    card.exampleEn,
    card.lemma,
    card.targetPos,
    card.verbFormLabel,
    card.expectedAnswer,
    card.sentenceWithGap,
    card.sentenceFull,
    card.translationFr,
    card.wordTraductionFr ?? null,
    card.grammarHint,
    card.inputPlaceholder,
    card.source,
    card.schemaVersion,
  );
}

async function loadSessionWords(env: Env, profileId: string, limit: number): Promise<PreparedWord[]> {
  const weaknessSignals = await loadRecentWeaknessSignals(env, profileId);
  const candidateLimit = Math.min(Math.max(limit * 5, 80), 160);
  const levelFloor = await loadLevelFloorRank(env, profileId);
  const dueResult = await env.DB.prepare(`
    SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD},
      wp.prochaine_revision, wp.intervalle, wp.facilite, wp.repetitions,
      wp.derniere_revision, wp.seen_count, wp.success_count, wp.almost_count, wp.fail_count,
      wp.level, wp.status, wp.review_history, ${ENRICHMENT_SELECT_SQL}
    FROM words w
    INNER JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    ${ENRICHMENT_JOIN_SQL}
    WHERE wp.repetitions > 0 AND wp.prochaine_revision <= datetime('now')
      AND ${DUE_WORD_LEVEL_FILTER_SQL}
    ORDER BY
      CASE WHEN w.id LIKE 'assim_%' THEN 0 ELSE 1 END,
      wp.prochaine_revision ASC
    LIMIT ?
  `).bind(profileId, levelFloor, candidateLimit).all<SessionWordRow & EnrichmentColumns>();

  const dueWords = orderWordsForWeakness(dueResult.results.map(hydrateExistingWord), weaknessSignals, limit);
  const newLimit = Math.max(0, limit - dueWords.length);
  if (newLimit <= 0) return dueWords;

  const newCandidateLimit = Math.min(newLimit * 3, 160);
  const newResult = await env.DB.prepare(`
    SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD}, ${ENRICHMENT_SELECT_SQL}
    FROM words w
    LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    ${ENRICHMENT_JOIN_SQL}
    WHERE wp.id IS NULL
      AND ${NEW_WORD_LEVEL_FILTER_SQL}
    ORDER BY
      CASE WHEN w.id LIKE 'assim_%' THEN 0 ELSE 1 END,
      w.frequence DESC,
      w.niveau ASC
    LIMIT ?
  `).bind(profileId, levelFloor, newCandidateLimit).all<WordRow & EnrichmentColumns>();

  const now = new Date().toISOString();
  // Dépriorisation des A1 probablement acquis : le pool est d'abord trié par
  // priorité d'apprentissage (score explicable), puis par faiblesses détectées.
  const priorityPool = rankNewWordsByPriority(newResult.results, Math.min(newLimit * 2, 120));
  const newWords = orderWordsForWeakness(priorityPool.map((word) => hydrateNewWord(word, now)), weaknessSignals, newLimit);
  return [...dueWords, ...newWords];
}

async function loadPreparedCards(
  env: Env,
  profileId: string,
  words: PreparedWord[],
  options: { forceRebuildInvalid?: boolean } = {},
): Promise<{ cards: PreparedCard[]; rebuilt: number; reused: number; rejected: Array<{ wordId: string; reasons: string[] }> }> {
  if (!words.length) {
    return { cards: [], rebuilt: 0, reused: 0, rejected: [] };
  }

  const placeholders = words.map(() => '?').join(', ');
  const ids = words.map((word) => word.id);
  const assimilLessonsByIndex = await loadAssimilLessonRowsForWords(env, words);
  const existing = await env.DB.prepare(`
    SELECT * FROM lingvist_cards
    WHERE profile_id = ? AND word_id IN (${placeholders}) AND schema_version = ?
  `).bind(profileId, ...ids, SCHEMA_VERSION).all<CardRow>();

  const byWordId = new Map<string, PreparedCard>();
  const rejected: Array<{ wordId: string; reasons: string[] }> = [];
  let reused = 0;

  for (const row of existing.results) {
    const word = words.find((candidate) => candidate.id === row.word_id);
    const card = serializeCard(row);
    const quality = word ? assessCardQuality(word, card) : missingWordQuality();

    if (quality.isValid || !options.forceRebuildInvalid) {
      const safeCard = word
        ? {
          ...sanitizeCardHint(word, card),
          qualityReasons: quality.reasons,
          qualityScore: quality.score,
          qualityStatus: quality.isValid ? 'valid' as const : 'needs_regeneration' as const,
        }
        : card;
      byWordId.set(row.word_id, safeCard);
      reused += 1;
    } else {
      rejected.push({ wordId: row.word_id, reasons: quality.reasons });
    }
  }

  const missingCards = words
    .filter((word) => !byWordId.has(word.id))
    .map(buildLocalPreparedCard);

  if (missingCards.length) {
    await env.DB.batch(missingCards.map((card) => upsertCardStatement(env, profileId, card)));
    for (const card of missingCards) {
      const word = words.find((candidate) => candidate.id === card.wordId);
      const quality = word ? assessCardQuality(word, card) : null;
      byWordId.set(card.wordId, {
        ...card,
        qualityReasons: quality?.reasons ?? [],
        qualityScore: quality?.score ?? card.qualityScore,
        qualityStatus: 'rebuilt',
      });
    }
  }

  return {
    cards: words
      .map((word) => {
        const card = byWordId.get(word.id);
        return card ? attachAssimilMetadata(word, card, assimilLessonsByIndex) : null;
      })
      .filter((card): card is PreparedCard => Boolean(card)),
    rebuilt: missingCards.length,
    reused,
    rejected,
  };
}

export async function handleLingvistSession(req: Request, env: Env): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const profileId = params.get('profileId') ?? 'default';
  const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '40', 10), 1), 80);
  const words = await loadSessionWords(env, profileId, limit);
  const preparation = await loadPreparedCards(env, profileId, words, { forceRebuildInvalid: true });
  const wordsById = new Map(words.map((word) => [word.id, word]));
  // Les cartes préparées avant une correction gardent l'ancienne traduction :
  // la traduction publiée par l'atelier la remplace pour le même mot.
  const cards = preparation.cards.map((card) => {
    const translation = enrichedTranslation(wordsById.get(card.wordId));
    return translation ? { ...card, wordTraductionFr: translation } : card;
  });

  return json({
    sessionId: `${profileId}_${Date.now()}`,
    preparedAt: new Date().toISOString(),
    words,
    cards,
    counts: {
      words: words.length,
      cards: cards.length,
      localCards: cards.filter((card) => card.source === 'local').length,
      remoteCards: cards.filter((card) => card.source === 'remote').length,
      rebuiltCards: preparation.rebuilt,
      reusedCards: preparation.reused,
      qualityAverage: averageQuality(cards),
      needsRegeneration: cards.filter((card) => card.qualityStatus === 'needs_regeneration').length,
    },
  });
}

function averageQuality(cards: PreparedCard[]): number {
  if (!cards.length) return 0;
  const total = cards.reduce((sum, card) => sum + (card.qualityScore ?? 0.7), 0);
  return Math.round((total / cards.length) * 100) / 100;
}

export async function handleLingvistPrepare(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const body: { profileId?: string; limit?: number } = req.method === 'POST'
    ? await req.json<{ profileId?: string; limit?: number }>().catch(() => ({}))
    : {};
  const profileId = body.profileId ?? url.searchParams.get('profileId') ?? 'default';
  const limit = Math.min(Math.max(Number(body.limit ?? url.searchParams.get('limit') ?? 40), 1), 80);
  const words = await loadSessionWords(env, profileId, limit);
  const preparation = await loadPreparedCards(env, profileId, words, { forceRebuildInvalid: true });

  return json({
    ok: true,
    profileId,
    preparedAt: new Date().toISOString(),
    counts: {
      words: words.length,
      cards: preparation.cards.length,
      rebuiltCards: preparation.rebuilt,
      reusedCards: preparation.reused,
      rejectedCards: preparation.rejected.length,
      localCards: preparation.cards.filter((card) => card.source === 'local').length,
      remoteCards: preparation.cards.filter((card) => card.source === 'remote').length,
      qualityAverage: averageQuality(preparation.cards),
      needsRegeneration: preparation.cards.filter((card) => card.qualityStatus === 'needs_regeneration').length,
    },
    rejected: preparation.rejected,
    audioBookLessons: {
      available: true,
      prefix: 'audio-book-lesson/',
      firstKey: 'audio-book-lesson/L000-LESSON.mp3',
      lastKey: 'audio-book-lesson/L100-LESSON.mp3',
      urlPattern: '/audio/audio-book-lesson/L000-LESSON.mp3',
    },
  });
}

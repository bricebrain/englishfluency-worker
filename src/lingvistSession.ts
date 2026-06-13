import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

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
  grammarHint: string;
  inputPlaceholder: string;
  source: 'remote' | 'local';
  schemaVersion: number;
}

interface CardQuality {
  isValid: boolean;
  reasons: string[];
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

function hydrateExistingWord(row: SessionWordRow): PreparedWord {
  return {
    ...row,
    examples: parseJson<Array<{ en: string; fr: string }>>(row.examples, []),
    review_history: parseJson<unknown[]>(row.review_history, []),
  };
}

function hydrateNewWord(row: WordRow, now: string): PreparedWord {
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
    grammarHint: buildSafeGrammarHint(word, targetPos, targetPos === 'verb' ? inferVerbLabel(sentenceFull, answer) : null),
    inputPlaceholder: targetPos === 'verb' ? 'Ecris la bonne forme verbale' : 'Ecris le mot manquant',
    source: 'local',
    schemaVersion: SCHEMA_VERSION,
  };
}

function isVerbLike(type: string | null): boolean {
  const lower = (type ?? '').toLowerCase();
  return /(^|[^a-z])v\.?($|[^a-z])/.test(lower) || /\bverb\b/.test(lower) || /\bmodal\b/.test(lower);
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
    grammarHint: row.grammar_hint,
    inputPlaceholder: row.input_placeholder,
    source: row.source === 'remote' ? 'remote' : 'local',
    schemaVersion: row.schema_version,
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

  return {
    isValid: reasons.length === 0,
    reasons,
  };
}

function upsertCardStatement(env: Env, profileId: string, card: PreparedCard): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO lingvist_cards (
      id, profile_id, word_id, example_en, lemma, target_pos, verb_form_label,
      expected_answer, sentence_with_gap, sentence_full, translation_fr,
      grammar_hint, input_placeholder, source, schema_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      example_en=excluded.example_en, lemma=excluded.lemma,
      target_pos=excluded.target_pos, verb_form_label=excluded.verb_form_label,
      expected_answer=excluded.expected_answer, sentence_with_gap=excluded.sentence_with_gap,
      sentence_full=excluded.sentence_full, translation_fr=excluded.translation_fr,
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
    card.grammarHint,
    card.inputPlaceholder,
    card.source,
    card.schemaVersion,
  );
}

async function loadSessionWords(env: Env, profileId: string, limit: number): Promise<PreparedWord[]> {
  const dueResult = await env.DB.prepare(`
    SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD},
      wp.prochaine_revision, wp.intervalle, wp.facilite, wp.repetitions,
      wp.derniere_revision, wp.seen_count, wp.success_count, wp.almost_count, wp.fail_count,
      wp.level, wp.status, wp.review_history
    FROM words w
    INNER JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    WHERE wp.repetitions > 0 AND wp.prochaine_revision <= datetime('now')
    ORDER BY wp.prochaine_revision ASC
    LIMIT ?
  `).bind(profileId, limit).all<SessionWordRow>();

  const dueWords = dueResult.results.map(hydrateExistingWord);
  const newLimit = Math.max(0, limit - dueWords.length);
  if (newLimit <= 0) return dueWords;

  const newResult = await env.DB.prepare(`
    SELECT w.id, w.mot, w.type, w.niveau, w.traduction, w.ipa_uk, w.ipa_us, ${SELECT_WORD}
    FROM words w
    LEFT JOIN word_progress wp ON wp.word_id = w.id AND wp.profile_id = ?
    WHERE wp.id IS NULL
    ORDER BY w.frequence DESC, w.niveau ASC
    LIMIT ?
  `).bind(profileId, newLimit).all<WordRow>();

  const now = new Date().toISOString();
  return [...dueWords, ...newResult.results.map((word) => hydrateNewWord(word, now))];
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
    const quality = word ? assessCardQuality(word, card) : { isValid: false, reasons: ['word_missing'] };

    if (quality.isValid || !options.forceRebuildInvalid) {
      const safeCard = word ? sanitizeCardHint(word, card) : card;
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
      byWordId.set(card.wordId, card);
    }
  }

  return {
    cards: words.map((word) => byWordId.get(word.id)).filter((card): card is PreparedCard => Boolean(card)),
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
  const cards = preparation.cards;

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
    },
  });
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

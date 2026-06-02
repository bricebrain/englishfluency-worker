/**
 * POST /articles/lesson   — leçon complète calibrée CEFR (vocab + grammaire + texte + question)
 * POST /articles/feedback — évalue la réponse libre de l'apprenant (contenu + grammaire + modèle)
 *
 * Pipeline : Gemini 3.5 Flash → fallback DeepSeek V4 Flash.
 */

import type { Env } from './types';
import { json, err, isAuthorized } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VocabItem {
  term: string;           // expression anglaise
  definition_fr: string;  // définition courte en français (≤ 8 mots)
  example: string;        // exemple anglais dans un contexte tech
}

export interface GrammarPoint {
  pattern: string;  // nom du pattern (ex: "Present perfect passive")
  example: string;  // extrait du titre ou du texte
  tip_fr: string;   // tip pédagogique en français (≤ 15 mots)
}

export interface ArticleLesson {
  hash: string;
  level: string;
  vocabulary: VocabItem[];
  grammar: GrammarPoint;
  reading: string;   // texte EN 150-200 mots, adapté au niveau, réutilise les 3 termes
  question: string;  // question de compréhension EN sur le texte de lecture
}

interface LessonRequest {
  hash?: string;
  title: string;
  summary_fr?: string | null;
  theme?: string | null;
  level?: string | null;  // CEFR : A1 | A2 | B1 | B2 | C1
}

// ─── Calibrage par niveau ─────────────────────────────────────────────────────

const LEVEL_STYLE: Record<string, string> = {
  A1: 'Use only present simple and "to be". Max 6 words per sentence. Only the most common 500 English words. No subordinate clauses.',
  A2: 'Use present simple, past simple, going-to future. Max 10 words per sentence. Common everyday vocabulary. Simple connectors (and, but, because, so).',
  B1: 'Use full past tenses, present perfect, will/going-to future, simple conditionals. 12-15 words per sentence. Relative clauses allowed.',
  B2: 'Use full tense range including passive. 15-20 words per sentence. Complex relative clauses, reported speech. Standard tech vocabulary.',
  C1: 'Use complex structures: mixed conditionals, cleft sentences, nominalisations. 20-25 words per sentence. Idiomatic collocations.',
};

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(level: string): string {
  const style = LEVEL_STYLE[level] ?? LEVEL_STYLE['B1'];
  return `You are an English teacher for French speakers. The learner's CEFR level is: ${level}.

Your task: generate a complete reading lesson from a tech article headline.

Respond ONLY with a JSON object — no markdown, no extra text — with exactly this structure:
{
  "vocabulary": [
    { "term": "...", "definition_fr": "...", "example": "..." },
    { "term": "...", "definition_fr": "...", "example": "..." },
    { "term": "...", "definition_fr": "...", "example": "..." }
  ],
  "grammar": {
    "pattern": "...",
    "example": "...",
    "tip_fr": "..."
  },
  "reading": "...",
  "question": "..."
}

Rules for each field:

vocabulary (3 entries, calibrated to ${level}):
- "term": an English word or expression from the title or context, appropriate for ${level} level
- "definition_fr": French definition, max 8 words, clear and simple
- "example": 1 short English sentence using the term in a tech context (NOT the article title itself)

grammar (1 entry):
- "pattern": name of the grammar structure found in the article title (passive, present perfect, gerund, modal, compound noun, etc.)
- "example": exact short quote from the article title illustrating this pattern
- "tip_fr": 1 pedagogical sentence in French, max 15 words

reading (single string, 150-200 words):
- Write an English text about the article's topic at EXACTLY ${level} level
- Writing style for ${level}: ${style}
- The text MUST naturally use the 3 vocabulary terms you defined above
- Cover the key information from the article (what happened, who, what impact)
- Do NOT invent facts — base everything on the title and summary provided
- The text should feel like a short news brief, not a lesson
- Do NOT start with "In this article" or "Today we learn"

question (single string):
- ONE comprehension question in English about the reading text you just wrote (not the original article)
- Start with What / How / Why / Which / Who
- Appropriate for ${level} level difficulty`;
}

function buildUserPrompt(req: LessonRequest): string {
  let prompt = `Article title (English): "${req.title}"`;
  if (req.summary_fr?.trim()) {
    prompt += `\n\nFrench summary: "${req.summary_fr.trim()}"`;
  }
  if (req.theme) {
    prompt += `\n\nTheme: ${req.theme}`;
  }
  return prompt;
}

// ─── LLM calls ───────────────────────────────────────────────────────────────

async function callChatCompletion(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<Omit<ArticleLesson, 'hash' | 'level'> | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 900,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json<{ choices?: [{ message?: { content?: string } }] }>();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    return JSON.parse(raw) as Omit<ArticleLesson, 'hash' | 'level'>;
  } catch {
    return null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleArticleLesson(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<LessonRequest>().catch(() => null);
  if (!body?.title?.trim()) return err('title requis', 400);

  const level = (body.level ?? 'B1').toUpperCase();
  const validLevels = ['A1', 'A2', 'B1', 'B2', 'C1'];
  const safeLevel = validLevels.includes(level) ? level : 'B1';

  const systemPrompt = buildSystemPrompt(safeLevel);
  const userPrompt = buildUserPrompt(body);

  // 1. Gemini 3.5 Flash — frontier performance, rapide, endpoint OpenAI-compatible
  const geminiKey = await env.GEMINI_API_KEY.get();
  if (geminiKey) {
    const lesson = await callChatCompletion(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      geminiKey,
      'gemini-3.5-flash',
      systemPrompt,
      userPrompt,
    );
    if (lesson) return json({ ...lesson, hash: body.hash ?? '', level: safeLevel });
  }

  // 2. Fallback DeepSeek V4 Flash — très capable, rapide
  const deepseekKey = await env.DEEPSEEK_API_KEY.get();
  if (deepseekKey) {
    const lesson = await callChatCompletion(
      'https://api.deepseek.com/chat/completions',
      deepseekKey,
      'deepseek-v4-flash',
      systemPrompt,
      userPrompt,
    );
    if (lesson) return json({ ...lesson, hash: body.hash ?? '', level: safeLevel });
  }

  return err('Génération de leçon indisponible', 503);
}

// ─── Answer feedback ─────────────────────────────────────────────────────────

export interface GrammarError {
  original: string;   // fragment tel qu'écrit par l'apprenant
  corrected: string;  // version corrigée
  tip_fr: string;     // explication pédagogique en français (≤ 12 mots)
}

export interface AnswerFeedback {
  content_ok: boolean;
  content_feedback_fr: string;  // 1-2 phrases FR : le contenu était-il juste ?
  grammar_errors: GrammarError[];
  model_answer: string;          // réponse modèle EN au niveau de l'apprenant
}

interface FeedbackRequest {
  question: string;
  answer: string;
  reading: string;  // le texte de lecture sur lequel porte la question
  level: string;
}

const FEEDBACK_SYSTEM = `You are a supportive English teacher for French speakers. Evaluate a learner's written answer to a reading comprehension question.

Respond ONLY with a JSON object — no markdown, no extra text:
{
  "content_ok": true/false,
  "content_feedback_fr": "...",
  "grammar_errors": [
    { "original": "...", "corrected": "...", "tip_fr": "..." }
  ],
  "model_answer": "..."
}

Rules:
- content_ok: true if the answer correctly addresses the question based on the reading text. false if it misses the point or is factually wrong relative to the text.
- content_feedback_fr: 1-2 sentences in French. Warm and constructive tone. If correct, acknowledge specifically what was good. If wrong, gently explain what was missed.
- grammar_errors: list ONLY clear grammatical errors (wrong tense, subject-verb agreement, missing article, wrong preposition). Do NOT flag style preferences or alternative phrasings. Empty array [] if no errors.
  - "original": the exact erroneous fragment (not the whole sentence)
  - "corrected": the corrected fragment only
  - "tip_fr": ≤12 words in French explaining the rule
- model_answer: 1-3 sentences in English at the learner's CEFR level, directly answering the question. Must be clearly correct and well-written. Do not start with "The text says" or "According to the text".`;

// ─── Promote article vocabulary → SRS ────────────────────────────────────────
// POST /articles/promote-words
// Marque les mots du vocabulaire d'un article comme "dus immédiatement" dans
// word_progress. Crée le mot dans words s'il n'existe pas encore.
// C'est le pont Assimil : phase passive (Lire) → phase active (Lingvist).

interface PromoteVocabItem {
  term: string;
  definition_fr: string;
  example: string;
}

interface PromoteWordsRequest {
  profileId: string;
  vocabulary: PromoteVocabItem[];
  level: string;
}

export async function handlePromoteWords(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<PromoteWordsRequest>().catch(() => null);
  if (!body?.profileId || !Array.isArray(body?.vocabulary) || body.vocabulary.length === 0) {
    return err('profileId et vocabulary requis', 400);
  }

  const level = (['A1','A2','B1','B2','C1'].includes((body.level ?? '').toUpperCase()))
    ? body.level.toUpperCase()
    : 'B1';

  let promoted = 0;
  let created  = 0;

  for (const item of body.vocabulary.slice(0, 5)) {
    const termRaw = (item.term ?? '').trim();
    if (!termRaw) continue;

    // 1. Cherche le mot dans la table words (insensible à la casse)
    const existing = await env.DB.prepare(
      'SELECT id FROM words WHERE LOWER(mot) = LOWER(?) LIMIT 1'
    ).bind(termRaw).first<{ id: string }>();

    let wordId: string;

    if (existing) {
      wordId = existing.id;
    } else {
      // 2. Crée le mot avec les données de la leçon
      wordId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR IGNORE INTO words (id, mot, type, niveau, traduction, examples, audio_uk, audio_us, frequence)
        VALUES (?, ?, 'noun', ?, ?, ?, '', '', 3)
      `).bind(
        wordId,
        termRaw,
        level,
        item.definition_fr ?? termRaw,
        JSON.stringify([{ en: item.example ?? termRaw, fr: item.definition_fr ?? termRaw }]),
      ).run();
      created++;
    }

    // 3. Upsert word_progress — due immédiatement (phase active Assimil)
    const progressId = `${body.profileId}_${wordId}`;
    await env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, datetime('now'), 0, 2.5, 1, datetime('now'), 1, 0, 0, 0, 1, 'learning', '[]', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision = datetime('now'),
        status = 'learning',
        updated_at = datetime('now')
    `).bind(progressId, body.profileId, wordId).run();
    promoted++;
  }

  return json({ ok: true, promoted, created });
}

// POST /articles/feedback
export async function handleAnswerFeedback(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<FeedbackRequest>().catch(() => null);
  if (!body?.question?.trim() || !body?.answer?.trim() || !body?.reading?.trim()) {
    return err('question, answer et reading requis', 400);
  }

  const level = (body.level ?? 'B1').toUpperCase();

  const userPrompt =
    `CEFR level: ${level}\n\n` +
    `Reading text:\n"${body.reading}"\n\n` +
    `Question: "${body.question}"\n\n` +
    `Learner's answer: "${body.answer.trim()}"`;

  // 1. Gemini 3.5 Flash
  const geminiKey = await env.GEMINI_API_KEY.get();
  if (geminiKey) {
    const feedback = await callChatCompletion(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      geminiKey,
      'gemini-3.5-flash',
      FEEDBACK_SYSTEM,
      userPrompt,
    ) as AnswerFeedback | null;
    if (feedback) return json(feedback);
  }

  // 2. Fallback DeepSeek V4 Flash
  const deepseekKey = await env.DEEPSEEK_API_KEY.get();
  if (deepseekKey) {
    const feedback = await callChatCompletion(
      'https://api.deepseek.com/chat/completions',
      deepseekKey,
      'deepseek-v4-flash',
      FEEDBACK_SYSTEM,
      userPrompt,
    ) as AnswerFeedback | null;
    if (feedback) return json(feedback);
  }

  return err('Correction indisponible', 503);
}

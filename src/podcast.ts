/**
 * podcast.ts — Podcast pédagogique quotidien basé sur les articles TechPulse.
 *
 * GET  /podcasts/daily          — retourne le podcast du jour (D1 cache)
 * POST /podcasts/generate       — force la (re)génération (admin / cron manuel)
 * scheduled()                   — cron Cloudflare (7h / 12h / 18h UTC)
 *
 * Format : dialogue host ↔ learner + quiz 3 MCQ + transcript bilingue.
 * Niveau : B1 par défaut (le plus courant), sélectionnable via ?level=
 * Stockage : table `content` (type='daily_podcast', profile_id='__global__')
 */

import type { Env } from './types';
import { json, err } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PodcastSegment {
  speaker: 'host' | 'learner';
  text: string;         // English
  fr: string;           // French translation (for immersive transcript)
}

export interface QuizQuestion {
  question: string;
  choices: string[];    // 3 choices
  answerIndex: number;  // 0-based index of correct answer
  explanationFr: string;
}

export interface DailyPodcast {
  id: string;                   // 'daily_B1_YYYY-MM-DD'
  level: string;
  articleHash: string;
  articleTitle: string;
  articleTitleFr: string | null;
  articleSource: string;
  articleUrl: string | null;
  podcastTitle: string;
  keyVocab: string[];
  segments: PodcastSegment[];
  quiz: QuizQuestion[];
  generatedAt: number;
}

interface TechPulseArticle {
  hash: string;
  title: string;
  title_fr: string | null;
  source_name: string;
  url: string | null;
  summary_fr: string | null;
  theme: string;
  published_at: number | null;
}

// ─── Language detection ───────────────────────────────────────────────────────
// Détecte si un titre est en anglais (pas en français).

const FR_ACCENT_RE = /[éèêëàâçîïôûùœæÉÈÊËÀÂÇÎÏÔÛÙŒÆ]/g;
const FR_WORD_RE   = /\b(le|la|les|un|une|des|du|au|aux|est|sont|avec|pour|sur|dans|par|qui|que|où|ce|se|en|et|ou|mais|donc|car|ni|de|à)\b/gi;

function looksEnglish(title: string): boolean {
  if (!title || title.length < 5) return false;
  const accentCount = (title.match(FR_ACCENT_RE) ?? []).length;
  if (accentCount >= 3) return false; // 3+ accents typiquement français
  const words = title.split(/\s+/).filter((w) => w.length > 1);
  if (words.length < 3) return true;  // trop court pour juger
  const frCount = (title.match(FR_WORD_RE) ?? []).length;
  return frCount / words.length <= 0.25; // >25% mots FR → probablement français
}

// ─── AI generation ────────────────────────────────────────────────────────────

async function callChatCompletion(
  endpoint: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.5,
        max_tokens:  2000,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a podcast scriptwriter for an English learning app aimed at French speakers.
Your podcasts are based on real tech news articles.
ALWAYS return ONLY valid JSON, no markdown fences, no extra text.`;

function buildPrompt(article: TechPulseArticle, level: string): string {
  const levelGuide: Record<string, string> = {
    A2: 'Simple sentences (max 12 words). Basic vocabulary. Present/past simple only.',
    B1: 'Clear sentences (max 15 words). Standard vocabulary. Full tense range.',
    B2: 'Natural sentences. Rich vocabulary. Complex structures allowed.',
    C1: 'Sophisticated language. Idiomatic expressions. Advanced collocations.',
  };
  const guide = levelGuide[level] ?? levelGuide['B1'];

  return `Create an English learning podcast episode based on this real tech news article.

Article title (English): "${article.title}"
Article summary (French): "${article.summary_fr ?? 'No summary available'}"
Source: ${article.source_name}

Level: ${level} — ${guide}

Return ONLY this JSON structure:
{
  "podcastTitle": "short engaging podcast title (max 8 words)",
  "keyVocab": ["word1", "word2", "word3", "word4"],
  "segments": [
    { "speaker": "host",    "text": "...", "fr": "French translation of this line" },
    { "speaker": "learner", "text": "...", "fr": "French translation of this line" }
  ],
  "quiz": [
    {
      "question": "...",
      "choices": ["choice A", "choice B", "choice C"],
      "answerIndex": 0,
      "explanationFr": "Short explanation in French why this is correct"
    }
  ]
}

Requirements:
- 7–9 segments total, alternating host/learner
- Host introduces topic, explains key vocabulary, discusses implications
- Learner asks natural questions, reflects, shows comprehension
- Each segment: 1–2 natural spoken sentences
- "fr" field: precise, natural French translation of each segment
- keyVocab: 4 key English words from the article (with level-appropriate selection)
- 3 quiz questions testing real comprehension of the article content
- All quiz questions answerable from the podcast content
- Exactly 3 choices per question, exactly 1 correct answer
- explanationFr: ≤15 words in French
- Language level ${level}: respect grammar complexity guide above
- Base content ONLY on the real article facts — do not invent`;
}

// ─── Core generation ──────────────────────────────────────────────────────────

async function generatePodcast(
  article: TechPulseArticle,
  level: string,
  env: Env,
): Promise<Omit<DailyPodcast, 'id' | 'level' | 'articleHash' | 'articleTitle' | 'articleTitleFr' | 'articleSource' | 'articleUrl' | 'generatedAt'> | null> {
  const systemPrompt = SYSTEM_PROMPT;
  const userPrompt   = buildPrompt(article, level);

  // 1. Gemini 3.5 Flash
  const geminiKey = await env.GEMINI_API_KEY.get().catch(() => null);
  if (geminiKey) {
    const raw = await callChatCompletion(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      geminiKey, 'gemini-3.5-flash', systemPrompt, userPrompt,
    );
    if (raw) {
      const parsed = tryParse(raw);
      if (parsed) return parsed;
    }
  }

  // 2. DeepSeek V4 Flash fallback
  const deepseekKey = await env.DEEPSEEK_API_KEY.get().catch(() => null);
  if (deepseekKey) {
    const raw = await callChatCompletion(
      'https://api.deepseek.com/chat/completions',
      deepseekKey, 'deepseek-v4-flash', systemPrompt, userPrompt,
    );
    if (raw) {
      const parsed = tryParse(raw);
      if (parsed) return parsed;
    }
  }

  return null;
}

function tryParse(raw: string): { podcastTitle: string; keyVocab: string[]; segments: PodcastSegment[]; quiz: QuizQuestion[] } | null {
  try {
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    const parsed = JSON.parse(raw.slice(first, last + 1)) as {
      podcastTitle?: string;
      keyVocab?: string[];
      segments?: PodcastSegment[];
      quiz?: QuizQuestion[];
    };
    if (!parsed.segments?.length || !parsed.quiz?.length) return null;
    return {
      podcastTitle: String(parsed.podcastTitle ?? 'Daily Podcast'),
      keyVocab:     Array.isArray(parsed.keyVocab) ? parsed.keyVocab : [],
      segments:     parsed.segments,
      quiz:         parsed.quiz,
    };
  } catch {
    return null;
  }
}

// ─── TechPulse fetch + filter ─────────────────────────────────────────────────

async function fetchEnglishArticles(env: Env, limit = 10): Promise<TechPulseArticle[]> {
  try {
    const res = await env.TECHPULSE.fetch(
      new Request(`http://techpulse/articles/recent?hours=12&limit=${limit}`),
    );
    if (!res.ok) return [];
    const data = await res.json<{ articles?: TechPulseArticle[] }>().catch(() => ({ articles: [] }));
    const articles = data?.articles ?? (Array.isArray(data) ? (data as TechPulseArticle[]) : []);
    return articles.filter((a) => looksEnglish(a.title));
  } catch {
    return [];
  }
}

// ─── D1 store / retrieve ──────────────────────────────────────────────────────

const GLOBAL_PROFILE = '__global__';

async function storePodcast(podcast: DailyPodcast, env: Env): Promise<void> {
  // Supprimer l'ancien podcast du même jour/niveau s'il existe
  await env.DB.prepare(
    `DELETE FROM content WHERE type = 'daily_podcast' AND profile_id = ? AND id = ?`,
  ).bind(GLOBAL_PROFILE, podcast.id).run();

  await env.DB.prepare(
    `INSERT INTO content (id, profile_id, type, title, level, topic, body, metadata)
     VALUES (?, ?, 'daily_podcast', ?, ?, ?, ?, ?)`,
  ).bind(
    podcast.id,
    GLOBAL_PROFILE,
    podcast.podcastTitle,
    podcast.level,
    podcast.articleTitle,
    JSON.stringify(podcast),
    JSON.stringify({ generatedAt: podcast.generatedAt, articleSource: podcast.articleSource }),
  ).run();
}

async function getLatestPodcast(env: Env, _level: string): Promise<DailyPodcast | null> {
  try {
    // Cherche le podcast d'aujourd'hui (id = daily_<level>_YYYY-MM-DD)
    const today = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      `SELECT body FROM content
       WHERE type = 'daily_podcast' AND profile_id = ? AND id LIKE ?
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(GLOBAL_PROFILE, `daily_%_${today}`).first<{ body: string }>();

    if (!row?.body) return null;
    return JSON.parse(row.body) as DailyPodcast;
  } catch {
    return null;
  }
}

// ─── Pub: generate + store ────────────────────────────────────────────────────

export async function generateAndStoreDailyPodcast(env: Env, level = 'B1'): Promise<DailyPodcast | null> {
  const articles = await fetchEnglishArticles(env, 10);
  if (articles.length === 0) return null;

  // Prendre l'article le plus récent avec un titre substantiel (> 30 chars)
  const article = articles.find((a) => a.title.length > 30) ?? articles[0];

  const result = await generatePodcast(article, level, env);
  if (!result) return null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const podcast: DailyPodcast = {
    id:               `daily_${level}_${today}`,
    level,
    articleHash:      article.hash,
    articleTitle:     article.title,
    articleTitleFr:   article.title_fr,
    articleSource:    article.source_name,
    articleUrl:       article.url,
    podcastTitle:     result.podcastTitle,
    keyVocab:         result.keyVocab,
    segments:         result.segments,
    quiz:             result.quiz,
    generatedAt:      Date.now(),
  };

  await storePodcast(podcast, env);
  return podcast;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** GET /podcasts/daily?level=B1 */
export async function handleGetDailyPodcast(req: Request, env: Env): Promise<Response> {
  const url   = new URL(req.url);
  const level = url.searchParams.get('level')?.toUpperCase() ?? 'B1';

  // Cherche le podcast le plus récent en D1
  const cached = await getLatestPodcast(env, level);
  if (cached) return json(cached);

  // Rien en cache → génération à la volée (premier appel)
  const generated = await generateAndStoreDailyPodcast(env, level);
  if (!generated) return err('Podcast indisponible — réessaie dans quelques minutes', 503);

  return json(generated);
}

/** POST /podcasts/generate  — force la régénération (admin) */
export async function handleGeneratePodcast(req: Request, env: Env): Promise<Response> {
  const url   = new URL(req.url);
  const level = url.searchParams.get('level')?.toUpperCase() ?? 'B1';
  const podcast = await generateAndStoreDailyPodcast(env, level);
  if (!podcast) return err('Génération échouée', 503);
  return json({ ok: true, id: podcast.id, title: podcast.podcastTitle });
}

/**
 * channelLessons.ts — Leçons pédagogiques générées depuis des vidéos YouTube.
 *
 * GET  /lessons/channel?level=B1          — leçon du jour (cache D1 ou génération)
 * GET  /admin/channels                    — liste toutes les chaînes
 * POST /admin/channels                    — ajoute une chaîne  { id, name }
 * PATCH /admin/channels/:id               — toggle active      { active: 0|1 }
 * DELETE /admin/channels/:id              — supprime une chaîne
 *
 * Les chaînes sont stockées dans la table D1 `youtube_channels`.
 * `id` peut être un channel_id YouTube (UCxxx) ou un alias `user:NomDeCompte`.
 * Pas de clé YouTube requise — utilise les flux RSS publics.
 */

import type { Env } from './types';
import { json, err } from './utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChannelLesson {
  id:          string;   // 'channel_B1_YYYY-MM-DD'
  level:       string;
  source:      'channel';
  titleFr:     string;
  titleEn:     string;
  taglineFr:   string;
  category:    string;
  durationMin: number;
  steps:       unknown[];
  vocabulary:  unknown[];
  tags:        string[];
  videoUrl:    string;
  videoId:     string;
  channelName: string;
  videoTitle:  string;
  generatedAt: number;
}

interface YtVideo {
  videoId:     string;
  title:       string;
  description: string;
  publishedAt: string;
  channelName: string;
}

interface ChannelRow {
  id:         string;
  name:       string;
  active:     number;
  created_at: string;
}

const DEFAULT_CHANNELS = [
  { id: 'UCHaHD477h-FeBbVh9Sh7syA', name: 'BBC Learning English' },
  { id: 'UCKyTokYo0nK2OA-az-sDijA', name: 'VOA Learning English' },
  { id: 'UCxJGMJbjokfnr2-s4_RXPxQ', name: 'Speak English With Vanessa' },
  { id: 'UCicjynhfFw2LiIQFnoS1JTw', name: "Let's Talk" },
  { id: 'UCKRBA9XfgzAtJodE4t8cUeg', name: 'engVid' },
  { id: 'user:Ispeakspokespoken', name: 'iSpeakSpokeSpoken' },
] as const;

function buildYoutubeFeedUrl(channelRef: string): string {
  return channelRef.startsWith('user:')
    ? `https://www.youtube.com/feeds/videos.xml?user=${encodeURIComponent(channelRef.slice(5))}`
    : `https://www.youtube.com/feeds/videos.xml?channel_id=${channelRef}`;
}

// ─── D1 channel management ────────────────────────────────────────────────────

async function getActiveChannels(env: Env): Promise<{ id: string; name: string }[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM youtube_channels WHERE active = 1 ORDER BY created_at ASC`,
    ).all<{ id: string; name: string }>();
    return results ?? [];
  } catch {
    // Fallback si la table n'existe pas encore (migration pas encore appliquée)
    return [...DEFAULT_CHANNELS];
  }
}

// ─── Admin handlers ───────────────────────────────────────────────────────────

/** GET /admin/channels */
export async function handleListChannels(_req: Request, env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, active, created_at FROM youtube_channels ORDER BY created_at ASC`,
  ).all<ChannelRow>();
  return json({ channels: results ?? [] });
}

/** POST /admin/channels  body: { id, name } */
export async function handleAddChannel(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ id?: string; name?: string }>().catch(() => null);
  if (!body?.id || !body?.name) return err('Champs requis : id, name', 400);

  const channelId = body.id.trim();
  const name      = body.name.trim();

  // Vérifie que le flux RSS existe
  const test = await fetch(buildYoutubeFeedUrl(channelId), {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!test.ok) return err(`Channel introuvable (RSS ${test.status}). Vérifie l'ID.`, 422);

  await env.DB.prepare(
    `INSERT INTO youtube_channels (id, name, active) VALUES (?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, active = 1`,
  ).bind(channelId, name).run();

  return json({ ok: true, id: channelId, name });
}

/** PATCH /admin/channels/:id  body: { active: 0|1 } */
export async function handleToggleChannel(req: Request, env: Env, channelId: string): Promise<Response> {
  const body = await req.json<{ active?: number }>().catch(() => null);
  if (body?.active === undefined) return err('Champ requis : active (0 ou 1)', 400);

  const result = await env.DB.prepare(
    `UPDATE youtube_channels SET active = ? WHERE id = ?`,
  ).bind(body.active ? 1 : 0, channelId).run();

  if (!result.meta.changes) return err('Chaîne introuvable', 404);
  return json({ ok: true, id: channelId, active: body.active ? 1 : 0 });
}

/** DELETE /admin/channels/:id */
export async function handleDeleteChannel(_req: Request, env: Env, channelId: string): Promise<Response> {
  const result = await env.DB.prepare(
    `DELETE FROM youtube_channels WHERE id = ?`,
  ).bind(channelId).run();

  if (!result.meta.changes) return err('Chaîne introuvable', 404);
  return json({ ok: true, deleted: channelId });
}

// ─── RSS parsing ──────────────────────────────────────────────────────────────

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

async function fetchChannelVideos(channelId: string, channelName: string): Promise<YtVideo[]> {
  try {
    const res = await fetch(
      buildYoutubeFeedUrl(channelId),
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EnglishFluency/1.0)' } },
    );
    if (!res.ok) return [];
    const xml = await res.text();

    // Split into <entry> blocks
    const entries = xml.split('<entry>').slice(1).map((e) => e.split('</entry>')[0]);

    return entries.slice(0, 12).flatMap((entry) => {
      const videoId = extractTag(entry, 'yt:videoId');
      if (!videoId) return [];
      const title       = extractTag(entry, 'media:title') || extractTag(entry, 'title');
      const description = extractTag(entry, 'media:description');
      const publishedAt = extractTag(entry, 'published');
      return [{
        videoId,
        title,
        description: description.slice(0, 1600), // cap tokens
        publishedAt,
        channelName,
      }];
    });
  } catch {
    return [];
  }
}

// ─── Video selection ──────────────────────────────────────────────────────────

// Keywords that signal a grammar/vocabulary lesson (not pure news / opinion)
const LESSON_KW = /grammar|vocabulary|tense|verb|adjective|adverb|preposition|conditional|passive|modal|phrase|pronunciation|idiom|expression|lesson|learn|english/i;

// Level hints in BBC titles like "[B1]" or "B1:" or "- B1"
function detectVideoLevel(video: YtVideo): string | null {
  const t = video.title;
  for (const lvl of ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']) {
    if (new RegExp(`[\\[\\s\\-:]${lvl}[\\]\\s\\-:]|^${lvl}[^\\d]`).test(t)) return lvl;
  }
  return null;
}

function pickVideoForLevel(videos: YtVideo[], level: string): YtVideo | null {
  if (!videos.length) return null;

  // 1. Exact level + lesson keyword
  const exactLesson = videos.find((v) =>
    detectVideoLevel(v) === level && LESSON_KW.test(v.title),
  );
  if (exactLesson) return exactLesson;

  // 2. Exact level, any topic
  const exact = videos.find((v) => detectVideoLevel(v) === level);
  if (exact) return exact;

  // 3. Lesson keyword, any level
  const anyLesson = videos.find((v) => LESSON_KW.test(v.title) && v.description.length > 80);
  if (anyLesson) return anyLesson;

  // 4. First video with a meaningful description
  return videos.find((v) => v.description.length > 80) ?? videos[0];
}

// ─── AI generation ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  'You are an expert English teacher. Generate structured lessons from YouTube video content. ' +
  'ALWAYS return ONLY valid JSON, no markdown fences, no extra text.';

function buildPrompt(video: YtVideo, level: string): string {
  const guide: Record<string, string> = {
    A2: 'Simple sentences (max 10 words). Basic vocabulary. Present/past simple only.',
    B1: 'Clear grammar rules. Standard vocabulary. Full tense range.',
    B2: 'Complex grammar. Rich vocabulary. Nuanced usage.',
    C1: 'Advanced structures. Idiomatic expressions. Sophisticated exercises.',
  };

  return `Create a structured English learning lesson based on this YouTube video.

Channel: ${video.channelName}
Video title: "${video.title}"
Video description:
${video.description}

CEFR Level: ${level} — ${guide[level] ?? guide['B1']}

Extract the main grammar or vocabulary point from this video and create a complete lesson.

Return ONLY this JSON:
{
  "titleFr": "lesson title in French",
  "titleEn": "lesson title in English",
  "taglineFr": "short one-line description in French",
  "category": "grammar",
  "durationMin": 8,
  "steps": [
    { "type": "hook",     "emoji": "🎬", "titleFr": "Accroche",        "bodyFr": "Why this topic matters — in French" },
    { "type": "rule",     "emoji": "📐", "titleFr": "La règle",         "bodyFr": "Clear rule in French", "formula": "Subject + verb + ...", "formulaExample": "She has eaten · They have gone" },
    { "type": "examples", "emoji": "💡", "titleFr": "Exemples",         "examples": [{"en":"...","fr":"...","highlight":"key_word"},{"en":"...","fr":"...","highlight":"key_word"},{"en":"...","fr":"...","highlight":"key_word"}] },
    { "type": "exercise", "emoji": "✏️", "titleFr": "Complète la phrase","exercise": {"type":"fill_blank","sentence":"She ____ to the gym every day.","answer":"goes","hint":"présent simple"} },
    { "type": "exercise", "emoji": "🎯", "titleFr": "Choix multiple",   "exercise": {"type":"choice","question":"...","choices":["...","...","..."],"answerIndex":0,"explanationFr":"..."} },
    { "type": "recap",    "emoji": "✅", "titleFr": "Bilan",             "bodyFr": "Summary of what was learned — in French" }
  ],
  "vocabulary": [
    {"en": "word", "fr": "traduction", "example": "Example sentence using the word."}
  ],
  "tags": ["grammar", "youtube"]
}

Requirements:
- titleFr / bodyFr / taglineFr: ALWAYS in French
- All examples: English sentences with accurate French translations
- examples step: exactly 3 examples, each with a real highlight word
- vocabulary: 3–4 key words from the video topic
- fill_blank exercise: use ____ for the gap, real English sentence
- choice exercise: 3 choices, exactly 1 correct
- Content MUST be directly based on the video topic
- CEFR ${level}: respect the complexity guide above`;
}

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
        temperature: 0.4,
        max_tokens:  2200,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
    return data?.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

function tryParse(raw: string): Record<string, unknown> | null {
  try {
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    return JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function generateFromVideo(
  video: YtVideo,
  level: string,
  env: Env,
): Promise<Record<string, unknown> | null> {
  const sys  = SYSTEM_PROMPT;
  const user = buildPrompt(video, level);

  // 1. Gemini
  const geminiKey = await env.GEMINI_API_KEY.get().catch(() => null);
  if (geminiKey) {
    const raw = await callChatCompletion(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      geminiKey, 'gemini-3.5-flash', sys, user,
    );
    if (raw) { const p = tryParse(raw); if (p) return p; }
  }

  // 2. DeepSeek fallback
  const deepseekKey = await env.DEEPSEEK_API_KEY.get().catch(() => null);
  if (deepseekKey) {
    const raw = await callChatCompletion(
      'https://api.deepseek.com/chat/completions',
      deepseekKey, 'deepseek-v4-flash', sys, user,
    );
    if (raw) { const p = tryParse(raw); if (p) return p; }
  }

  return null;
}

// ─── D1 store / retrieve ──────────────────────────────────────────────────────

const GLOBAL = '__global__';

async function storeChannelLesson(lesson: ChannelLesson, env: Env): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM content WHERE type = 'channel_lesson' AND profile_id = ? AND id = ?`,
  ).bind(GLOBAL, lesson.id).run();

  await env.DB.prepare(
    `INSERT INTO content (id, profile_id, type, title, level, topic, body, metadata)
     VALUES (?, ?, 'channel_lesson', ?, ?, ?, ?, ?)`,
  ).bind(
    lesson.id, GLOBAL,
    lesson.titleEn, lesson.level, lesson.videoTitle,
    JSON.stringify(lesson),
    JSON.stringify({ channelName: lesson.channelName, videoId: lesson.videoId, generatedAt: lesson.generatedAt }),
  ).run();
}

async function getLatestChannelLesson(env: Env, level: string): Promise<ChannelLesson | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare(
      `SELECT body FROM content
       WHERE type = 'channel_lesson' AND profile_id = ? AND id = ?
       LIMIT 1`,
    ).bind(GLOBAL, `channel_${level}_${today}`).first<{ body: string }>();
    if (!row?.body) return null;
    return JSON.parse(row.body) as ChannelLesson;
  } catch {
    return null;
  }
}

// ─── Generate + store ─────────────────────────────────────────────────────────

export async function generateAndStoreChannelLesson(
  env: Env,
  level = 'B1',
): Promise<ChannelLesson | null> {
  // Récupère les chaînes actives depuis D1
  const channels = await getActiveChannels(env);
  if (!channels.length) return null;

  // Fetch videos from all channels in parallel
  const results = await Promise.all(
    channels.map((ch) => fetchChannelVideos(ch.id, ch.name)),
  );
  const allVideos: YtVideo[] = results.flat();
  if (!allVideos.length) return null;

  const video = pickVideoForLevel(allVideos, level);
  if (!video) return null;

  const parsed = await generateFromVideo(video, level, env);
  if (!parsed) return null;

  const today = new Date().toISOString().slice(0, 10);
  const lesson: ChannelLesson = {
    id:          `channel_${level}_${today}`,
    level,
    source:      'channel',
    titleFr:     String(parsed['titleFr'] ?? video.title),
    titleEn:     String(parsed['titleEn'] ?? video.title),
    taglineFr:   String(parsed['taglineFr'] ?? ''),
    category:    String(parsed['category'] ?? 'grammar'),
    durationMin: Number(parsed['durationMin'] ?? 8),
    steps:       (parsed['steps'] as unknown[]) ?? [],
    vocabulary:  (parsed['vocabulary'] as unknown[]) ?? [],
    tags:        (parsed['tags'] as string[]) ?? [],
    videoUrl:    `https://www.youtube.com/watch?v=${video.videoId}`,
    videoId:     video.videoId,
    channelName: video.channelName,
    videoTitle:  video.title,
    generatedAt: Date.now(),
  };

  await storeChannelLesson(lesson, env);
  return lesson;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** GET /lessons/channel?level=B1 */
export async function handleGetChannelLesson(req: Request, env: Env): Promise<Response> {
  const url   = new URL(req.url);
  const level = url.searchParams.get('level')?.toUpperCase() ?? 'B1';

  const cached = await getLatestChannelLesson(env, level);
  if (cached) return json(cached);

  const generated = await generateAndStoreChannelLesson(env, level);
  if (!generated) return err('Leçon YouTube indisponible — réessaie dans quelques minutes', 503);

  return json(generated);
}

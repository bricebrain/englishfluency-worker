/**
 * podcastFeeds — podcasts RSS anglais → transcripts Deepgram → reading lessons.
 *
 * Pipeline :
 *   POST /podcast-feeds                       → ajoute un feed + scanne le RSS
 *   POST /podcast-feeds/refresh               → re-scanne tous les feeds activés
 *   POST /podcast-feeds/episodes/:id/transcribe → Deepgram Nova-3 (réutilise assimilDeepgram.ts)
 *   POST /podcast-feeds/episodes/:id/lesson   → génère le ReadingLessonPack (LLM)
 *   GET  /podcast-feeds/recommend             → scoring Krashen i+1 (transcript × word_progress profil)
 *
 * Voir PODCAST_FEEDS_SPEC.md pour le contrat complet.
 */

import { XMLParser } from 'fast-xml-parser';
import type { Env } from './types';
import { json, err, isAuthorized } from './utils';
import { transcribeWithDeepgram } from './assimilDeepgram';

// ─── Types partagés (miroir côté app : src/types/podcastFeed.ts) ─────────────

export type PodcastFeedKind = 'conversation' | 'news' | 'tech';
export type TranscriptionStatus = 'pending' | 'transcribing' | 'ready' | 'failed';
export type LessonStatus = 'pending' | 'generating' | 'ready' | 'failed';

export interface PodcastFeed {
  id: string;
  title: string;
  rssUrl: string;
  kind: PodcastFeedKind;
  cefrLevelHint: string | null;
  enabled: boolean;
  imageUrl: string | null;
  lastFetchedAt: string | null;
  episodeCount: number;
  readyCount: number;
}

export interface DialogueLine {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export type DiscourseSignalCategory =
  | 'filler'
  | 'connector'
  | 'hedge'
  | 'reformulation'
  | 'backchannel'
  | 'liaison'
  | 'discourse_marker';

export interface DiscourseSignal {
  token: string;
  category: DiscourseSignalCategory;
  functionFr: string;
  exampleInText: string;
  register: 'formal' | 'informal' | 'neutral';
}

export interface EmergentGrammar {
  pattern: string;
  structureFr: string;
  exampleInText: string;
  why: string;
}

export interface ContextVocab {
  term: string;
  definitionFr: string;
  example: string;
  cefrLevel: string;
  register?: 'formal' | 'informal' | 'neutral';
}

export interface Collocation {
  phrase: string;
  meaningFr: string;
  example: string;
}

export interface ReadingLessonPack {
  level: string;
  summaryFr: string;
  readingLevels: {
    skim: { focus: string; question: string; answer: string };
    scan: { focus: string; items: { question: string; answer: string }[] };
    deep: { questions: { question: string; answer: string; type: 'literal' | 'inferential' | 'critical' }[] };
  };
  signals: DiscourseSignal[];
  grammarPoints: EmergentGrammar[];
  vocabulary: ContextVocab[];
  collocations: Collocation[];
  shadowingPrompts?: string[];
}

export interface PodcastEpisodeFull {
  id: string;
  feed: { id: string; title: string; kind: PodcastFeedKind; cefrLevelHint: string | null };
  title: string;
  description: string;
  durationSec: number | null;
  publishedAt: string | null;
  audioUrl: string;
  audioKey: string | null;
  transcriptionStatus: TranscriptionStatus;
  transcriptText: string | null;
  dialogue: DialogueLine[] | null;
  lesson: ReadingLessonPack | null;
}

export interface RecommendedEpisode {
  id: string;
  feedId: string;
  title: string;
  kind: PodcastFeedKind;
  cefrLevelHint: string | null;
  estimatedKnownRatio: number;
  estimatedUnknownCount: number;
  publishedAt: string | null;
  lessonStatus: LessonStatus;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function hashEpisodeId(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ep_${hex.slice(0, 16)}`;
}

function parseDuration(raw: unknown): number | null {
  if (typeof raw === 'number') return Math.round(raw);
  if (typeof raw !== 'string') return null;
  if (/^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  const parts = raw.trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

function safeText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as Record<string, unknown>)['#text']).trim() || null;
  }
  return null;
}

interface ParsedRssItem {
  title: string;
  description: string | null;
  audioUrl: string;
  durationSec: number | null;
  publishedAt: string | null;
  guid: string | null;
  imageUrl: string | null;
}

async function parseRssFeed(xml: string): Promise<{ channelTitle: string; imageUrl: string | null; items: ParsedRssItem[] }> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const channel = (parsed.rss as Record<string, unknown>)?.channel as Record<string, unknown> | undefined;
  if (!channel) return { channelTitle: '', imageUrl: null, items: [] };

  const channelTitle = safeText(channel.title) ?? '';
  const channelImage =
    (channel.image as Record<string, unknown>)?.['@_url'] as string | undefined ??
    (channel.image as Record<string, unknown>)?.url as string | undefined ??
    null;

  const rawItems = channel.item as Record<string, unknown>[] | Record<string, unknown> | undefined;
  const itemArray = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];
  const items: ParsedRssItem[] = [];

  for (const item of itemArray) {
    const enclosure = item.enclosure as Record<string, unknown> | undefined;
    const audioUrl = (enclosure?.['@_url'] as string | undefined) ?? null;
    if (!audioUrl) continue;

    const guid = safeText(item.guid);
    const pubDateRaw = safeText(item.pubDate);
    const publishedAt = pubDateRaw ? new Date(pubDateRaw).toISOString() : null;

    items.push({
      title: safeText(item.title) ?? 'Untitled',
      description: safeText(item.description),
      audioUrl,
      durationSec: parseDuration(item.duration),
      publishedAt,
      guid,
      imageUrl: (item.image as Record<string, unknown>)?.['@_href'] as string | undefined ?? null,
    });
  }

  return { channelTitle, imageUrl: channelImage ?? null, items };
}

interface FeedRow {
  id: string;
  title: string;
  rss_url: string;
  kind: PodcastFeedKind;
  cefr_level_hint: string | null;
  enabled: number;
  image_url: string | null;
  last_fetched_at: string | null;
}

function rowToFeed(row: FeedRow, episodeCount: number, readyCount: number): PodcastFeed {
  return {
    id: row.id,
    title: row.title,
    rssUrl: row.rss_url,
    kind: row.kind,
    cefrLevelHint: row.cefr_level_hint,
    enabled: row.enabled === 1,
    imageUrl: row.image_url,
    lastFetchedAt: row.last_fetched_at,
    episodeCount,
    readyCount,
  };
}

interface EpisodeRow {
  id: string;
  feed_id: string;
  title: string;
  description: string | null;
  audio_url: string;
  duration_sec: number | null;
  published_at: string | null;
  image_url: string | null;
  transcription_status: TranscriptionStatus;
  transcription_provider: string | null;
  transcript_text: string | null;
  dialogue_json: string | null;
  lesson_status: LessonStatus;
  lesson_json: string | null;
  audio_key: string | null;
}

function parseDialogue(json: string | null): DialogueLine[] | null {
  if (!json) return null;
  try { return JSON.parse(json) as DialogueLine[]; } catch { return null; }
}

function parseLesson(json: string | null): ReadingLessonPack | null {
  if (!json) return null;
  try { return JSON.parse(json) as ReadingLessonPack; } catch { return null; }
}

const VALID_KINDS: PodcastFeedKind[] = ['conversation', 'news', 'tech'];

// ─── Handlers : Feeds ─────────────────────────────────────────────────────────

// GET /podcast-feeds
export async function handleListPodcastFeeds(_req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(_req, env.API_SECRET)) return err('Non autorisé', 401);

  const feeds = await env.DB.prepare(
    `SELECT id, title, rss_url, kind, cefr_level_hint, enabled, image_url, last_fetched_at FROM podcast_feeds ORDER BY created_at`,
  ).all<FeedRow>();

  const result: PodcastFeed[] = [];
  for (const row of feeds.results ?? []) {
    const counts = await env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN lesson_status = 'ready' THEN 1 ELSE 0 END) as ready
       FROM podcast_episodes WHERE feed_id = ?`,
    ).bind(row.id).first<{ total: number; ready: number }>();
    result.push(rowToFeed(row, counts?.total ?? 0, counts?.ready ?? 0));
  }

  return json({ feeds: result });
}

// POST /podcast-feeds
export async function handleCreatePodcastFeed(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    id: string;
    title: string;
    rssUrl: string;
    kind: PodcastFeedKind;
    cefrLevelHint?: string | null;
  }>().catch(() => null);

  if (!body?.id?.trim() || !body?.rssUrl?.trim()) return err('id et rssUrl requis', 400);
  const kind = VALID_KINDS.includes(body.kind) ? body.kind : 'conversation';

  // Fetch + parse RSS
  const rssRes = await fetch(body.rssUrl, {
    headers: { 'User-Agent': 'englishfluency-worker/1.0' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!rssRes?.ok) return err(`RSS inaccessible: ${rssRes?.status ?? 'network error'}`, 502);

  const xml = await rssRes.text();
  const parsed = await parseRssFeed(xml);
  if (!parsed.items.length) return err('Aucun épisode trouvé dans le RSS', 400);

  // Insert feed
  await env.DB.prepare(
    `INSERT OR REPLACE INTO podcast_feeds (id, title, rss_url, kind, cefr_level_hint, image_url, last_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).bind(
    body.id.trim(),
    body.title?.trim() || parsed.channelTitle || body.id.trim(),
    body.rssUrl.trim(),
    kind,
    body.cefrLevelHint ?? null,
    parsed.imageUrl,
  ).run();

  // Insert episodes (skip duplicates via INSERT OR IGNORE)
  let scannedEpisodes = 0;
  for (const item of parsed.items.slice(0, 50)) {
    const epId = await hashEpisodeId(item.guid ?? item.audioUrl);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO podcast_episodes
         (id, feed_id, title, description, audio_url, duration_sec, published_at, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      epId,
      body.id.trim(),
      item.title,
      item.description,
      item.audioUrl,
      item.durationSec,
      item.publishedAt,
      item.imageUrl,
    ).run();
    scannedEpisodes++;
  }

  return json({ ok: true, scannedEpisodes }, 201);
}

// PATCH /podcast-feeds/:feedId
export async function handlePatchPodcastFeed(req: Request, env: Env, feedId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<{
    enabled?: boolean;
    kind?: PodcastFeedKind;
    cefrLevelHint?: string | null;
  }>().catch(() => null);
  if (!body) return err('Body invalide', 400);

  const sets: string[] = [];
  const binds: (string | number | null)[] = [];

  if (typeof body.enabled === 'boolean') { sets.push('enabled = ?'); binds.push(body.enabled ? 1 : 0); }
  if (body.kind && VALID_KINDS.includes(body.kind)) { sets.push('kind = ?'); binds.push(body.kind); }
  if (body.cefrLevelHint !== undefined) { sets.push('cefr_level_hint = ?'); binds.push(body.cefrLevelHint); }

  if (!sets.length) return err('Aucun champ à mettre à jour', 400);
  sets.push("updated_at = datetime('now')");
  binds.push(feedId);

  await env.DB.prepare(`UPDATE podcast_feeds SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return json({ ok: true });
}

// DELETE /podcast-feeds/:feedId
export async function handleDeletePodcastFeed(req: Request, env: Env, feedId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  // Récupère les audio_keys pour cleanup R2
  const episodes = await env.DB.prepare(
    `SELECT audio_key FROM podcast_episodes WHERE feed_id = ? AND audio_key IS NOT NULL`,
  ).bind(feedId).all<{ audio_key: string }>();

  for (const ep of episodes.results ?? []) {
    if (ep.audio_key) await env.AUDIO.delete(ep.audio_key).catch(() => {});
  }

  await env.DB.prepare(`DELETE FROM podcast_episodes WHERE feed_id = ?`).bind(feedId).run();
  const result = await env.DB.prepare(`DELETE FROM podcast_feeds WHERE id = ?`).bind(feedId).run();

  if (!result.meta.changes) return err('Feed introuvable', 404);
  return json({ ok: true });
}

// POST /podcast-feeds/refresh
export async function handleRefreshPodcastFeeds(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const feeds = await env.DB.prepare(
    `SELECT id, rss_url FROM podcast_feeds WHERE enabled = 1`,
  ).all<{ id: string; rss_url: string }>();

  let newEpisodes = 0;

  for (const feed of feeds.results ?? []) {
    const rssRes = await fetch(feed.rss_url, {
      headers: { 'User-Agent': 'englishfluency-worker/1.0' },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!rssRes?.ok) continue;

    const xml = await rssRes.text();
    const parsed = await parseRssFeed(xml);

    for (const item of parsed.items.slice(0, 30)) {
      const epId = await hashEpisodeId(item.guid ?? item.audioUrl);
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO podcast_episodes
           (id, feed_id, title, description, audio_url, duration_sec, published_at, image_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        epId, feed.id, item.title, item.description, item.audioUrl,
        item.durationSec, item.publishedAt, item.imageUrl,
      ).run();
      if (result.meta.changes) newEpisodes++;
    }

    await env.DB.prepare(
      `UPDATE podcast_feeds SET last_fetched_at = datetime('now') WHERE id = ?`,
    ).bind(feed.id).run();
  }

  return json({ ok: true, newEpisodes });
}

// ─── Handlers : Épisodes ──────────────────────────────────────────────────────

// GET /podcast-feeds/:feedId/episodes
export async function handleListEpisodes(req: Request, env: Env, feedId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
  const statusFilter = url.searchParams.get('status');

  let query = `SELECT id, feed_id, title, description, duration_sec, published_at, image_url,
                      transcription_status, lesson_status, audio_key
               FROM podcast_episodes WHERE feed_id = ?`;
  const binds: (string | number)[] = [feedId];

  if (statusFilter === 'ready') {
    query += ` AND lesson_status = 'ready'`;
  } else if (statusFilter === 'pending') {
    query += ` AND transcription_status = 'pending'`;
  }

  query += ` ORDER BY published_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...binds).all();

  const episodes = (result.results ?? []).map((row) => ({
    id: row.id as string,
    feedId: row.feed_id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    durationSec: row.duration_sec as number | null,
    publishedAt: row.published_at as string | null,
    imageUrl: row.image_url as string | null,
    transcriptionStatus: row.transcription_status as TranscriptionStatus,
    lessonStatus: row.lesson_status as LessonStatus,
    hasAudioMirror: !!row.audio_key,
  }));

  return json({ episodes });
}

// GET /podcast-feeds/episodes/:episodeId
export async function handleGetEpisode(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.audio_url, e.duration_sec, e.published_at,
            e.audio_key, e.transcription_status, e.transcript_text, e.dialogue_json,
            e.lesson_status, e.lesson_json,
            f.id as feed_id, f.title as feed_title, f.kind as feed_kind, f.cefr_level_hint as feed_cefr
     FROM podcast_episodes e
     JOIN podcast_feeds f ON e.feed_id = f.id
     WHERE e.id = ?`,
  ).bind(episodeId).first<EpisodeRow & {
    feed_id: string; feed_title: string; feed_kind: PodcastFeedKind; feed_cefr: string | null;
  }>();

  if (!row) return err('Épisode introuvable', 404);

  const episode: PodcastEpisodeFull = {
    id: row.id,
    feed: {
      id: row.feed_id,
      title: row.feed_title,
      kind: row.feed_kind,
      cefrLevelHint: row.feed_cefr,
    },
    title: row.title,
    description: row.description ?? '',
    durationSec: row.duration_sec,
    publishedAt: row.published_at,
    audioUrl: row.audio_url,
    audioKey: row.audio_key,
    transcriptionStatus: row.transcription_status,
    transcriptText: row.transcript_text,
    dialogue: parseDialogue(row.dialogue_json),
    lesson: parseLesson(row.lesson_json),
  };

  return json(episode);
}

// POST /podcast-feeds/episodes/:episodeId/transcribe
export async function handleTranscribeEpisode(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare(
    `SELECT audio_url FROM podcast_episodes WHERE id = ?`,
  ).bind(episodeId).first<{ audio_url: string }>();
  if (!row) return err('Épisode introuvable', 404);

  // Status → transcribing
  await env.DB.prepare(
    `UPDATE podcast_episodes SET transcription_status = 'transcribing', updated_at = datetime('now') WHERE id = ?`,
  ).bind(episodeId).run();

  try {
    // Fetch audio
    const audioRes = await fetch(row.audio_url, {
      headers: { 'User-Agent': 'englishfluency-worker/1.0' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!audioRes.ok) throw new Error(`Audio fetch HTTP ${audioRes.status}`);

    const audioBuffer = await audioRes.arrayBuffer();
    const mimeType = audioRes.headers.get('Content-Type') ?? 'audio/mpeg';
    const audioKey = `podcasts/episodes/${episodeId}.mp3`;

    // Mirror R2 (pour Range/shadowing)
    await env.AUDIO.put(audioKey, audioBuffer);

    // Deepgram Nova-3 (réutilise assimilDeepgram.ts)
    const transcription = await transcribeWithDeepgram(env, {
      audio: audioBuffer,
      mimeType,
      minSpeakers: 2,
      maxSpeakers: 4,
    });

    // Construit le dialogue depuis les segments diarisés
    const dialogue: DialogueLine[] = transcription.segments.map((seg) => ({
      speaker: seg.speaker ?? 'speaker_0',
      text: seg.text,
      start: seg.start,
      end: seg.end,
    }));

    await env.DB.prepare(
      `UPDATE podcast_episodes
       SET transcription_status = 'ready',
           transcription_provider = 'deepgram',
           transcript_text = ?,
           dialogue_json = ?,
           audio_key = ?,
           updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(
      transcription.text,
      JSON.stringify(dialogue),
      audioKey,
      episodeId,
    ).run();

    return json({ ok: true, transcriptionStatus: 'ready', dialogue });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE podcast_episodes SET transcription_status = 'failed', updated_at = datetime('now') WHERE id = ?`,
    ).bind(episodeId).run();
    return err(`Transcription échouée: ${error instanceof Error ? error.message : 'unknown'}`, 500);
  }
}

// GET /podcast-feeds/episodes/:episodeId/transcription-status
export async function handleEpisodeTranscriptionStatus(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare(
    `SELECT transcription_status, transcription_provider FROM podcast_episodes WHERE id = ?`,
  ).bind(episodeId).first<{ transcription_status: TranscriptionStatus; transcription_provider: string | null }>();

  if (!row) return err('Épisode introuvable', 404);
  return json({ status: row.transcription_status, provider: row.transcription_provider });
}

// ─── Handlers : Lesson generation (LLM) ──────────────────────────────────────

async function callLlmJson(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<ReadingLessonPack | null> {
  // 1. Gemini 3.5 Flash (endpoint OpenAI-compatible)
  const geminiKey = await env.GEMINI_API_KEY.get();
  if (geminiKey) {
    try {
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${geminiKey}` },
          body: JSON.stringify({
            model: 'gemini-3.5-flash',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            temperature: 0.4,
            max_tokens: 3000,
            response_format: { type: 'json_object' },
          }),
        },
      );
      if (res.ok) {
        const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const raw = data?.choices?.[0]?.message?.content ?? '';
        if (raw) return JSON.parse(raw) as ReadingLessonPack;
      }
    } catch { /* fallback */ }
  }

  // 2. Fallback DeepSeek V4 Flash
  const deepseekKey = await env.DEEPSEEK_API_KEY.get();
  if (deepseekKey) {
    try {
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.4,
          max_tokens: 3000,
          response_format: { type: 'json_object' },
        }),
      });
      if (res.ok) {
        const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
        const raw = data?.choices?.[0]?.message?.content ?? '';
        if (raw) return JSON.parse(raw) as ReadingLessonPack;
      }
    } catch { /* fail */ }
  }

  return null;
}

// POST /podcast-feeds/episodes/:episodeId/lesson
export async function handleGenerateEpisodeLesson(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare(
    `SELECT e.transcript_text, e.dialogue_json, f.kind, f.cefr_level_hint
     FROM podcast_episodes e
     JOIN podcast_feeds f ON e.feed_id = f.id
     WHERE e.id = ? AND e.transcription_status = 'ready'`,
  ).bind(episodeId).first<{
    transcript_text: string | null;
    dialogue_json: string | null;
    kind: PodcastFeedKind;
    cefr_level_hint: string | null;
  }>();

  if (!row) return err('Épisode introuvable ou non transcrit', 404);
  if (!row.transcript_text) return err('Transcript manquant', 400);

  // Status → generating
  await env.DB.prepare(
    `UPDATE podcast_episodes SET lesson_status = 'generating', updated_at = datetime('now') WHERE id = ?`,
  ).bind(episodeId).run();

  const dialogue = parseDialogue(row.dialogue_json);
  const systemPrompt = buildLessonSystemPrompt(row.kind, row.cefr_level_hint);
  const userPrompt = buildLessonUserPrompt(row.transcript_text, dialogue, row.cefr_level_hint);

  const lesson = await callLlmJson(env, systemPrompt, userPrompt);

  if (!lesson) {
    await env.DB.prepare(
      `UPDATE podcast_episodes SET lesson_status = 'failed', updated_at = datetime('now') WHERE id = ?`,
    ).bind(episodeId).run();
    return err('Génération de leçon indisponible', 503);
  }

  await env.DB.prepare(
    `UPDATE podcast_episodes SET lesson_status = 'ready', lesson_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(JSON.stringify(lesson), episodeId).run();

  return json({ ok: true, lesson });
}

// GET /podcast-feeds/episodes/:episodeId/lesson
export async function handleGetEpisodeLesson(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const row = await env.DB.prepare(
    `SELECT lesson_json, lesson_status FROM podcast_episodes WHERE id = ?`,
  ).bind(episodeId).first<{ lesson_json: string | null; lesson_status: LessonStatus }>();

  if (!row) return err('Épisode introuvable', 404);
  if (row.lesson_status !== 'ready' || !row.lesson_json) return err('Lesson non générée', 404);

  return json(parseLesson(row.lesson_json));
}

// ─── Handlers : Recommandation (Krashen i+1) ─────────────────────────────────

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z\s'-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

// GET /podcast-feeds/recommend?profileId=...&kind=conversation&limit=10
export async function handleRecommendEpisodes(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const profileId = url.searchParams.get('profileId');
  const kind = url.searchParams.get('kind') as PodcastFeedKind | null;
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10) || 10, 30);

  if (!profileId) return err('profileId requis', 400);

  // 1. Lexique connu du profil (level >= 2)
  const knownRows = await env.DB.prepare(
    `SELECT w.mot FROM word_progress wp
     JOIN words w ON wp.word_id = w.id
     WHERE wp.profile_id = ? AND wp.level >= 2`,
  ).bind(profileId).all<{ mot: string }>();

  const knownSet = new Set((knownRows.results ?? []).map((r) => r.mot.toLowerCase()));

  // 2. Épisodes prêts (lesson_status = 'ready')
  let query = `SELECT e.id, e.feed_id, e.title, e.transcript_text, e.published_at, e.lesson_status,
                      f.kind, f.cefr_level_hint
               FROM podcast_episodes e
               JOIN podcast_feeds f ON e.feed_id = f.id
               WHERE e.lesson_status = 'ready' AND e.transcript_text IS NOT NULL`;
  const binds: (string | number)[] = [];
  if (kind && VALID_KINDS.includes(kind)) {
    query += ` AND f.kind = ?`;
    binds.push(kind);
  }
  query += ` LIMIT 200`;

  const episodes = await env.DB.prepare(query).bind(...binds).all<{
    id: string; feed_id: string; title: string; transcript_text: string;
    published_at: string | null; lesson_status: LessonStatus;
    kind: PodcastFeedKind; cefr_level_hint: string | null;
  }>();

  // 3. Scoring i+1
  const scored: RecommendedEpisode[] = [];

  for (const ep of episodes.results ?? []) {
    const tokens = tokenize(ep.transcript_text);
    if (tokens.size < 10) continue;

    let knownCount = 0;
    for (const token of tokens) {
      if (knownSet.has(token)) knownCount++;
    }

    const unknownCount = tokens.size - knownCount;
    const knownRatio = knownCount / tokens.size;

    // Zone i+1 : 75%-92% de mots connus
    if (knownRatio < 0.75 || knownRatio > 0.92) continue;

    scored.push({
      id: ep.id,
      feedId: ep.feed_id,
      title: ep.title,
      kind: ep.kind,
      cefrLevelHint: ep.cefr_level_hint,
      estimatedKnownRatio: Math.round(knownRatio * 100) / 100,
      estimatedUnknownCount: unknownCount,
      publishedAt: ep.published_at,
      lessonStatus: ep.lesson_status,
    });
  }

  // 4. Tri : unknownCount ASC (priorité aux épisodes avec peu de nouveau), puis publishedAt DESC
  scored.sort((a, b) => {
    if (a.estimatedUnknownCount !== b.estimatedUnknownCount) {
      return a.estimatedUnknownCount - b.estimatedUnknownCount;
    }
    return (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '');
  });

  return json({ episodes: scored.slice(0, limit) });
}

// ─── Prompts LLM ──────────────────────────────────────────────────────────────

export function buildLessonSystemPrompt(kind: PodcastFeedKind, _levelHint: string | null): string {
  const base = `You are an English teacher for French speakers. From the given English transcript, extract a reading lesson pack.

CRITICAL RULES:
- Every signal, grammar point, vocabulary example, and collocation example MUST be quoted verbatim from the actual transcript text. Never invent examples.
- Detect the most plausible CEFR level (A1-C1) from the vocabulary density and sentence complexity.
- functionFr and structureFr and meaningFr must be in French, concise (≤ 12-20 words).
- Output strict JSON matching the ReadingLessonPack schema:

{
  "level": "B1",
  "summaryFr": "...",
  "readingLevels": {
    "skim": { "focus": "...", "question": "...", "answer": "..." },
    "scan": { "focus": "...", "items": [{ "question": "...", "answer": "..." }] },
    "deep": { "questions": [{ "question": "...", "answer": "...", "type": "literal" }] }
  },
  "signals": [{ "token": "...", "category": "filler", "functionFr": "...", "exampleInText": "...", "register": "informal" }],
  "grammarPoints": [{ "pattern": "...", "structureFr": "...", "exampleInText": "...", "why": "..." }],
  "vocabulary": [{ "term": "...", "definitionFr": "...", "example": "...", "cefrLevel": "B1", "register": "neutral" }],
  "collocations": [{ "phrase": "...", "meaningFr": "...", "example": "..." }],
  "shadowingPrompts": ["...", "..."]
}`;

  if (kind === 'conversation') {
    return `${base}

This is a CONVERSATION transcript (diarized). Focus specifically on:
- Conversation signals: fillers (um, well, like, you know), backchannels (mm-hmm, right, yeah), reformulations (I mean, what I'm saying is), turn-taking markers.
- Spoken contractions and liaisons: gonna, wanna, gotta, kinda, sort of, 've got, y'know, dunno.
- Phrasal verbs used in context.
- Informal register.
- Provide 3-5 shadowingPrompts: natural sentences worth repeating out loud, quoted verbatim from the transcript.`;
  }

  if (kind === 'news') {
    return `${base}

This is a NEWS/RÉCIT transcript. Focus specifically on:
- Discourse structure: lead, topic sentences, connectors of cause/effect and temporal sequence (however, meanwhile, as a result, due to).
- Formal register and journalistic vocabulary.
- Reporting verbs and attribution patterns.`;
  }

  return base;
}

export function buildLessonUserPrompt(
  transcriptText: string,
  dialogue: DialogueLine[] | null,
  cefrLevelHint: string | null,
): string {
  const levelLine = cefrLevelHint ? `\nEstimated level range: ${cefrLevelHint}.` : '';
  if (dialogue && dialogue.length) {
    const dialogueText = dialogue
      .map((d) => `[${d.speaker} @ ${d.start.toFixed(1)}s] ${d.text}`)
      .join('\n');
    return `Transcript (diarized conversation):${levelLine}\n\n${dialogueText}`;
  }
  return `Transcript:${levelLine}\n\n${transcriptText}`;
}

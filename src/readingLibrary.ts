import { XMLParser } from 'fast-xml-parser';
import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

interface SourceRow {
  category: string;
  cefr_hint: string | null;
  enabled: number;
  id: string;
  kind: string;
  last_fetched_at: string | null;
  provider: string;
  title: string;
  url: string;
}

interface ItemRow {
  audio_url: string | null;
  category: string;
  description: string | null;
  id: string;
  image_url: string | null;
  level: string;
  published_at: string | null;
  raw_text: string;
  segment_count: number;
  source_id: string;
  source_provider?: string;
  source_title?: string;
  status: string;
  summary_fr: string | null;
  title: string;
  updated_at: string;
  url: string;
  word_count: number;
}

interface SegmentRow {
  id: string;
  item_id: string;
  level: string;
  questions_json: string;
  segment_index: number;
  shadowing_json: string;
  summary_fr: string;
  text: string;
  title: string;
  vocabulary_json: string;
  word_count: number;
}

interface ParsedFeedItem {
  audioUrl: string | null;
  description: string | null;
  guid: string | null;
  imageUrl: string | null;
  link: string | null;
  publishedAt: string | null;
  text: string;
  title: string;
}

interface ArticlePageContent {
  audioUrl: string | null;
  imageUrl: string | null;
  text: string;
}

const MAX_PREPARE_LIMIT = 5;
const MAX_SEGMENTS_PER_ITEM = 6;
const DEFAULT_MAX_AGE_DAYS = 5;
const DAY_MS = 86_400_000;

function decodeHtml(value: string): string {
  let decoded = value;
  for (let index = 0; index < 3; index += 1) {
    const next = decoded
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#8217;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"');
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
}

function stripHtml(value: string | null | undefined): string {
  return decodeHtml(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractBetween(value: string, startMarker: string, endMarker: string): string | null {
  const startIndex = value.indexOf(startMarker);
  if (startIndex === -1) return null;
  const contentStart = startIndex + startMarker.length;
  const endIndex = value.indexOf(endMarker, contentStart);
  if (endIndex === -1) return null;
  return value.slice(contentStart, endIndex);
}

function extractFirstUrl(value: string | null | undefined, matcher?: RegExp): string | null {
  const decoded = decodeHtml(value ?? '');
  const matches = [...decoded.matchAll(/https?:\/\/[^\s"'<>]+/g)]
    .map((match) => match[0]?.replace(/[),.]+$/, '') ?? '')
    .filter(Boolean);
  if (!matcher) return matches[0] ?? null;
  return matches.find((url) => matcher.test(url)) ?? null;
}

function safeText(value: unknown): string | null {
  if (typeof value === 'string') return stripHtml(value) || null;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['#text'] === 'string') return stripHtml(record['#text']) || null;
  }
  return null;
}

function arrayify<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[a-zA-Z]/.test(word)).length;
}

function parsePublishedAt(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function isFreshEnough(item: ParsedFeedItem, maxAgeDays: number): boolean {
  const publishedAt = parsePublishedAt(item.publishedAt);
  if (!publishedAt) return false;
  const publishedTime = Date.parse(publishedAt);
  const cutoff = Date.now() - maxAgeDays * DAY_MS;
  return publishedTime >= cutoff && publishedTime <= Date.now() + DAY_MS;
}

async function stableHash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 18);
}

function estimateLevel(text: string, fallback: string | null): string {
  const words = text.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  const longWords = words.filter((word) => word.length >= 9).length;
  const avgWordLength = words.reduce((sum, word) => sum + word.length, 0) / Math.max(1, words.length);
  const density = longWords / Math.max(1, words.length);
  if (words.length < 80 && fallback) return fallback;
  if (density > 0.18 || avgWordLength > 5.6) return 'B2';
  if (density > 0.11 || avgWordLength > 5.1) return 'B1';
  return fallback ?? 'A2';
}

function extractVocabulary(text: string): string[] {
  const stop = new Set([
    'about', 'after', 'again', 'also', 'because', 'before', 'between', 'could', 'every',
    'first', 'from', 'have', 'into', 'more', 'most', 'other', 'people', 'said', 'some',
    'than', 'that', 'their', 'there', 'these', 'they', 'this', 'those', 'through', 'what',
    'when', 'where', 'which', 'while', 'with', 'would', 'your',
  ]);
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z'-]{4,}/g)) {
    const term = match[0]!.replace(/^'+|'+$/g, '');
    if (stop.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)
    .slice(0, 8)
    .map(([term]) => term);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
}

function splitSegments(text: string): string[] {
  const sentences = splitSentences(text);
  const segments: string[] = [];
  let current: string[] = [];
  let count = 0;

  for (const sentence of sentences) {
    const sentenceWords = wordCount(sentence);
    const shouldBreak = current.length > 0 && count + sentenceWords > 240;
    if (shouldBreak) {
      segments.push(current.join(' '));
      current = [];
      count = 0;
    }
    current.push(sentence);
    count += sentenceWords;
  }

  if (current.length) segments.push(current.join(' '));
  return segments.filter((segment) => wordCount(segment) >= 60).slice(0, MAX_SEGMENTS_PER_ITEM);
}

function buildSummaryFr(text: string): string {
  const sentences = splitSentences(text);
  const first = sentences[0] ?? text.slice(0, 180);
  return `À comprendre : ${first.slice(0, 180)}${first.length > 180 ? '...' : ''}`;
}

function pickShadowing(text: string): string[] {
  return splitSentences(text)
    .filter((sentence) => {
      const words = wordCount(sentence);
      return words >= 7 && words <= 18;
    })
    .slice(0, 3);
}

function buildQuestions(text: string): Array<{ answer: string; question: string; type: string }> {
  const sentences = splitSentences(text);
  const first = sentences[0] ?? text;
  const second = sentences.find((sentence) => sentence !== first) ?? first;
  return [
    {
      answer: first.slice(0, 180),
      question: 'What is the main idea of this passage?',
      type: 'gist',
    },
    {
      answer: second.slice(0, 180),
      question: 'Which detail helps you understand the situation?',
      type: 'detail',
    },
  ];
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapItem(row: ItemRow) {
  return {
    audioUrl: row.audio_url,
    category: row.category,
    description: row.description,
    id: row.id,
    imageUrl: row.image_url,
    level: row.level,
    publishedAt: row.published_at,
    segmentCount: row.segment_count,
    sourceId: row.source_id,
    sourceProvider: row.source_provider,
    sourceTitle: row.source_title,
    status: row.status,
    summaryFr: row.summary_fr,
    title: row.title,
    updatedAt: row.updated_at,
    url: row.url,
    wordCount: row.word_count,
  };
}

function mapSegment(row: SegmentRow) {
  return {
    id: row.id,
    itemId: row.item_id,
    level: row.level,
    questions: parseJsonArray(row.questions_json),
    segmentIndex: row.segment_index,
    shadowingPrompts: parseJsonArray<string>(row.shadowing_json),
    summaryFr: row.summary_fr,
    text: row.text,
    title: row.title,
    vocabulary: parseJsonArray<string>(row.vocabulary_json),
    wordCount: row.word_count,
  };
}

function pickAtomLink(rawLink: unknown): string | null {
  const links = arrayify(rawLink as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const preferred = links.find((link) => !link['@_rel'] || link['@_rel'] === 'alternate') ?? links[0];
  return (preferred?.['@_href'] as string | undefined) ?? safeText(preferred) ?? null;
}

function parseFeed(xml: string): ParsedFeedItem[] {
  const parser = new XMLParser({
    attributeNamePrefix: '@_',
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  const parsed = parser.parse(xml) as Record<string, unknown>;

  const feed = parsed.feed as Record<string, unknown> | undefined;
  if (feed?.entry) {
    return arrayify(feed.entry as Record<string, unknown> | Record<string, unknown>[])
      .map((entry) => {
        const rawContent = typeof entry.content === 'string'
          ? entry.content
          : typeof (entry.content as Record<string, unknown> | undefined)?.['#text'] === 'string'
            ? String((entry.content as Record<string, unknown>)['#text'])
            : '';
        const content = safeText(entry.content) ?? safeText(entry.summary) ?? '';
        const imageUrl = rawContent.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ?? null;

        return {
          audioUrl: null,
          description: safeText(entry.summary),
          guid: safeText(entry.id),
          imageUrl: imageUrl ? decodeHtml(imageUrl) : null,
          link: pickAtomLink(entry.link),
          publishedAt: parsePublishedAt(safeText(entry.published) ?? safeText(entry.updated)),
          text: content,
          title: safeText(entry.title) ?? 'Untitled',
        };
      })
      .filter((item) => item.title && item.link && item.text && wordCount(item.text) >= 3);
  }

  const channel = (parsed.rss as Record<string, unknown>)?.channel as Record<string, unknown> | undefined;
  const rawItems = channel?.item as Record<string, unknown>[] | Record<string, unknown> | undefined;
  const items = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : [];

  return items.map((item) => {
    const enclosure = item.enclosure as Record<string, unknown> | undefined;
    const mediaContent = item.content as Record<string, unknown> | undefined;
    const rawDescription = typeof item.description === 'string'
      ? item.description
      : typeof (item.description as Record<string, unknown> | undefined)?.['#text'] === 'string'
        ? String((item.description as Record<string, unknown>)['#text'])
        : null;
    const description = safeText(item.description);
    const content = safeText(item['encoded']) ?? safeText(item.content) ?? description ?? '';
    const pubDate = safeText(item.pubDate);
    const transcriptUrl = extractFirstUrl(
      rawDescription,
      /bbc\.co\.uk\/learningenglish\/english\/features/i,
    );

    return {
      audioUrl: (enclosure?.['@_url'] as string | undefined)
        ?? (mediaContent?.['@_url'] as string | undefined)
        ?? null,
      description,
      guid: safeText(item.guid),
      imageUrl: ((item.image as Record<string, unknown> | undefined)?.['@_href'] as string | undefined) ?? null,
      link: transcriptUrl ?? safeText(item.link),
      publishedAt: parsePublishedAt(pubDate),
      text: content,
      title: safeText(item.title) ?? 'Untitled',
    };
  }).filter((item) => item.title && item.link && item.text && wordCount(item.text) >= 3);
}

async function fetchSourceItems(source: SourceRow): Promise<ParsedFeedItem[]> {
  const response = await fetch(source.url, {
    headers: { 'User-Agent': 'EnglishFluency/1.0 (+personal-learning-app)' },
  });
  if (!response.ok) throw new Error(`source_fetch_${response.status}`);
  return parseFeed(await response.text());
}

async function fetchArticlePageContent(url: string | null): Promise<ArticlePageContent | null> {
  if (!url) return null;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'EnglishFluency/1.0 (+personal-learning-app)' },
  });
  if (!response.ok) return null;

  const html = await response.text();
  const articleHtml = extractBetween(html, '<div id="article-content"', '<div class="footer-toolbar">')
    ?? extractBetween(html, '<div role="article">', '<div class="widget-container widget-container-right"')
    ?? extractBetween(html, '<div class="wsw">', '<div class="clear"></div>')
    ?? extractBetween(html, '<div id="story_text"', '<!-- /story_text -->');
  if (!articleHtml) return null;

  const paragraphMatches = [...articleHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1]))
    .filter((paragraph) => {
      if (paragraph.length < 30) return false;
      if (/^_{5,}$/.test(paragraph)) return false;
      if (/^(words in this story|i’m|i'm)\b/i.test(paragraph)) return false;
      if (/no media source currently available/i.test(paragraph)) return false;
      if (/^(share|direct link|pop-out player)\b/i.test(paragraph)) return false;
      return true;
    });

  const audioMatch = articleHtml.match(/https:\/\/[^"' ]+\.mp3(?:\?download=1)?/i);
  const imageMatch = html.match(/property="og:image"[^>]+content="([^"]+)"/i)
    ?? html.match(/content="([^"]+)"[^>]+property="og:image"/i);

  return {
    audioUrl: audioMatch?.[0]?.replace('?download=1', '') ?? null,
    imageUrl: imageMatch?.[1] ? decodeHtml(imageMatch[1]) : null,
    text: paragraphMatches.join('\n\n'),
  };
}

async function upsertFeedItem(env: Env, source: SourceRow, item: ParsedFeedItem) {
  const stableInput = item.guid ?? item.link ?? `${source.id}:${item.title}`;
  const id = `read_${await stableHash(stableInput)}`;
  const already = await env.DB.prepare(
    `SELECT id FROM reading_library_items WHERE id = ?`,
  ).bind(id).first<{ id: string }>();
  if (already) return { created: false, id };

  const pageContent = await fetchArticlePageContent(item.link).catch(() => null);
  const fullText = pageContent?.text && wordCount(pageContent.text) >= 120
    ? pageContent.text
    : item.text;
  const level = estimateLevel(fullText, source.cefr_hint);
  const segments = splitSegments(fullText);
  const summaryFr = buildSummaryFr(fullText);

  if (segments.length === 0) {
    return { created: false, id };
  }

  await env.DB.prepare(
    `INSERT INTO reading_library_items (
       id, source_id, title, url, published_at, description, raw_text, level, category,
       status, word_count, segment_count, summary_fr, audio_url, image_url, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, datetime('now'))`,
  ).bind(
    id,
    source.id,
    item.title,
    item.link ?? source.url,
    item.publishedAt,
    item.description,
    fullText,
    level,
    source.category,
    wordCount(fullText),
    segments.length,
    summaryFr,
    pageContent?.audioUrl ?? item.audioUrl,
    pageContent?.imageUrl ?? item.imageUrl,
  ).run();

  for (const [index, segment] of segments.entries()) {
    await env.DB.prepare(
      `INSERT INTO reading_library_segments (
         id, item_id, segment_index, title, text, summary_fr, level, word_count,
         vocabulary_json, questions_json, shadowing_json, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(
      `${id}-s${String(index + 1).padStart(3, '0')}`,
      id,
      index + 1,
      `Part ${index + 1}`,
      segment,
      buildSummaryFr(segment),
      estimateLevel(segment, level),
      wordCount(segment),
      JSON.stringify(extractVocabulary(segment)),
      JSON.stringify(buildQuestions(segment)),
      JSON.stringify(pickShadowing(segment)),
    ).run();
  }

  return { created: true, id, segmentCount: segments.length };
}

export async function prepareNextReadingItems(env: Env, limit = 3, options: { maxAgeDays?: number } = {}) {
  const cappedLimit = Math.max(1, Math.min(MAX_PREPARE_LIMIT, Math.floor(limit)));
  const maxAgeDays = Math.max(1, Math.min(30, Math.floor(options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS)));
  const { results: sources } = await env.DB.prepare(
    `SELECT * FROM reading_library_sources
     WHERE enabled = 1
     ORDER BY COALESCE(last_fetched_at, '1970-01-01') ASC, id ASC`,
  ).all<SourceRow>();

  const prepared: Array<{ created?: boolean; id?: string; segmentCount?: number; sourceId: string; title?: string }> = [];
  const maxPerSource = Math.max(1, Math.ceil(cappedLimit / Math.max(1, sources.length)));

  for (const source of sources) {
    if (prepared.length >= cappedLimit) break;
    let sourcePrepared = 0;
    const items = (await fetchSourceItems(source).catch(() => []))
      .filter((item) => isFreshEnough(item, maxAgeDays));
    await env.DB.prepare(
      `UPDATE reading_library_sources SET last_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).bind(source.id).run();

    for (const item of items) {
      if (prepared.length >= cappedLimit) break;
      if (sourcePrepared >= maxPerSource) break;
      const result = await upsertFeedItem(env, source, item);
      if (result.created) {
        prepared.push({ ...result, sourceId: source.id, title: item.title });
        sourcePrepared += 1;
      }
    }
  }

  return { maxAgeDays, ok: true, prepared, selected: prepared.length };
}

export async function handlePrepareNextReadingItems(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<{ limit?: number; maxAgeDays?: number }>()
    .catch((): { limit?: number; maxAgeDays?: number } => ({}));
  return json(await prepareNextReadingItems(env, Number(body.limit ?? 3), {
    maxAgeDays: Number(body.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS),
  }));
}

export async function handleListReadingLibraryItems(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') ?? 20)));
  const category = url.searchParams.get('category');
  const level = url.searchParams.get('level');
  const binds: Array<string | number> = [];
  let where = `WHERE i.status = 'ready'`;

  if (category && category !== 'all') {
    where += ` AND i.category = ?`;
    binds.push(category);
  }
  if (level && level !== 'Tout') {
    where += ` AND i.level = ?`;
    binds.push(level);
  }

  const { results } = await env.DB.prepare(
    `SELECT i.*, s.title AS source_title, s.provider AS source_provider
     FROM reading_library_items i
     JOIN reading_library_sources s ON s.id = i.source_id
     ${where}
     ORDER BY COALESCE(i.published_at, i.updated_at) DESC
     LIMIT ?`,
  ).bind(...binds, limit).all<ItemRow>();

  return json({ items: results.map(mapItem), ok: true });
}

export async function handleGetReadingLibrarySegments(req: Request, env: Env, itemId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const { results } = await env.DB.prepare(
    `SELECT * FROM reading_library_segments WHERE item_id = ? ORDER BY segment_index`,
  ).bind(itemId).all<SegmentRow>();

  return json({ itemId, items: results.map(mapSegment), ok: true });
}

import type { Env } from './types';
import { err, isAuthorized, json } from './utils';
import { loadSceneQuestions } from './dailyContent';

interface SrtCue {
  endMs: number;
  endTime: string;
  startMs: number;
  startTime: string;
  text: string;
}

interface SrtScene {
  difficultyScore: number;
  endMs: number;
  endTime: string;
  level: string;
  lineCount: number;
  shadowingPrompts: string[];
  shadowingScore: number;
  startMs: number;
  startTime: string;
  text: string;
  vocabulary: string[];
  wordCount: number;
  wordsPerMin: number;
}

interface ImportFolderBody {
  kind?: string;
  language?: string;
  limit?: number;
  prefix?: string;
  seasonLabel?: string;
  sourceId?: string;
  title?: string;
}

interface SourceRow {
  created_at: string;
  episode_count: number;
  id: string;
  kind: string;
  language: string;
  r2_prefix: string;
  ready_count: number;
  scene_count: number;
  season_label: string | null;
  title: string;
  updated_at: string;
}

interface EpisodeRow {
  created_at: string;
  duration_sec: number | null;
  episode_no: number;
  id: string;
  line_count: number;
  r2_key: string;
  scene_count: number;
  source_id: string;
  status: string;
  title: string;
  updated_at: string;
}

interface SceneRow {
  difficulty_score: number;
  end_ms: number;
  end_time: string;
  episode_id: string;
  id: string;
  level: string;
  line_count: number;
  scene_index: number;
  shadowing_json: string;
  shadowing_score: number;
  start_ms: number;
  start_time: string;
  status: string;
  summary_fr: string | null;
  text: string;
  vocabulary_json: string;
  word_count: number;
  words_per_min: number;
}

const MAX_IMPORT_FILES = 30;
const MAX_SRT_BYTES = 1_500_000;

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'srt-source';
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/^\/+/, '').replace(/\/?$/, '/');
}

function parseTimeToMs(raw: string): number | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const [, h, m, s, ms] = match;
  return ((Number(h) * 60 * 60) + (Number(m) * 60) + Number(s)) * 1000 + Number(ms);
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0'),
  ].join(':');
}

function cleanSubtitleLine(line: string): string {
  return line
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\([^)]+\)/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSrt(raw: string): SrtCue[] {
  const normalized = raw.replace(/\r/g, '').replace(/^\uFEFF/, '');
  const blocks = normalized.split(/\n{2,}/);
  const cues: SrtCue[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes('-->'));
    if (timeIndex === -1) continue;

    const [startRaw, endRaw] = lines[timeIndex]!.split('-->').map((part) => part.trim().split(/\s+/)[0]);
    if (!startRaw || !endRaw) continue;

    const startMs = parseTimeToMs(startRaw);
    const endMs = parseTimeToMs(endRaw);
    if (startMs === null || endMs === null || endMs <= startMs) continue;

    const text = lines
      .slice(timeIndex + 1)
      .map(cleanSubtitleLine)
      .filter((line) => Boolean(line) && !/^[-–]+$/.test(line))
      .join(' ')
      .replace(/^[-–]\s*/, '')
      .replace(/\s+[-–]\s+/g, ' ')
      .trim();

    if (!text || /^\[[^\]]+\]$/.test(text) || /^\([^)]+\)$/.test(text)) continue;
    cues.push({ endMs, endTime: formatTime(endMs), startMs, startTime: formatTime(startMs), text });
  }

  return cues;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[a-zA-Z]/.test(word)).length;
}

function estimateLevel(params: {
  avgWordsPerLine: number;
  wordsPerMin: number;
  longWordRatio: number;
  idiomCount: number;
}): { difficultyScore: number; level: string; shadowingScore: number } {
  const densityScore = Math.min(35, Math.max(0, Math.round((params.wordsPerMin - 85) / 4)));
  const lengthScore = Math.min(20, Math.round(params.avgWordsPerLine * 1.6));
  const longWordScore = Math.min(20, Math.round(params.longWordRatio * 80));
  const idiomScore = Math.min(20, params.idiomCount * 4);
  const difficultyScore = Math.max(10, Math.min(95, 25 + densityScore + lengthScore + longWordScore + idiomScore));
  const level = difficultyScore < 35 ? 'A2' : difficultyScore < 58 ? 'B1' : difficultyScore < 78 ? 'B2' : 'C1';
  const shadowingScore = Math.max(10, Math.min(95, 100 - Math.round(difficultyScore * 0.65) + (params.avgWordsPerLine < 9 ? 10 : 0)));
  return { difficultyScore, level, shadowingScore };
}

function extractVocabulary(text: string): string[] {
  const stop = new Set([
    'the', 'and', 'you', 'that', 'this', 'for', 'are', 'but', 'not', 'with', 'have', 'was',
    'what', 'your', 'all', 'can', 'just', 'get', 'got', 'out', 'about', 'from', 'they',
    'them', 'there', 'been', 'were', 'will', 'would', 'could', 'should', 'into', 'like',
  ]);
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z'-]{3,}/g)) {
    const term = match[0]!.replace(/^'+|'+$/g, '');
    if (stop.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([term]) => term);
}

function pickShadowingPrompts(cues: SrtCue[]): string[] {
  return cues
    .map((cue) => cue.text)
    .filter((text) => {
      const words = wordCount(text);
      return words >= 4 && words <= 14 && /[.!?]$/.test(text);
    })
    .slice(0, 4);
}

function countIdioms(text: string): number {
  const lower = text.toLowerCase();
  const markers = [
    'kind of', 'sort of', 'you know', 'i mean', 'come on', 'hang on', 'figure out',
    'what the', 'no way', 'fair enough', 'as if', 'get out of', 'look at',
  ];
  return markers.reduce((count, marker) => count + (lower.includes(marker) ? 1 : 0), 0);
}

function buildScene(cues: SrtCue[]): SrtScene {
  const startMs = cues[0]?.startMs ?? 0;
  const endMs = cues.at(-1)?.endMs ?? startMs;
  const durationMin = Math.max(0.1, (endMs - startMs) / 60000);
  const text = cues.map((cue) => cue.text).join('\n');
  const words = wordCount(text);
  const wordsPerMin = Math.round(words / durationMin);
  const avgWordsPerLine = words / Math.max(1, cues.length);
  const longWords = (text.match(/\b[a-zA-Z]{9,}\b/g) ?? []).length;
  const estimates = estimateLevel({
    avgWordsPerLine,
    idiomCount: countIdioms(text),
    longWordRatio: longWords / Math.max(1, words),
    wordsPerMin,
  });

  return {
    ...estimates,
    endMs,
    endTime: formatTime(endMs),
    lineCount: cues.length,
    shadowingPrompts: pickShadowingPrompts(cues),
    startMs,
    startTime: formatTime(startMs),
    text,
    vocabulary: extractVocabulary(text),
    wordCount: words,
    wordsPerMin,
  };
}

function splitScenes(cues: SrtCue[]): SrtScene[] {
  const groups: SrtCue[][] = [];
  let current: SrtCue[] = [];

  for (const cue of cues) {
    const previous = current.at(-1);
    const gapMs = previous ? cue.startMs - previous.endMs : 0;
    const currentDuration = current.length ? (previous!.endMs - current[0]!.startMs) : 0;
    const currentWords = wordCount(current.map((item) => item.text).join(' '));
    const shouldBreak = current.length > 0 && (
      gapMs > 3500
      || current.length >= 16
      || currentDuration >= 110_000
      || currentWords >= 170
    );

    if (shouldBreak) {
      groups.push(current);
      current = [];
    }
    current.push(cue);
  }

  if (current.length) groups.push(current);

  const merged: SrtCue[][] = [];
  for (const group of groups) {
    const last = merged.at(-1);
    const groupDuration = group.at(-1)!.endMs - group[0]!.startMs;
    if (last && (group.length < 3 || groupDuration < 18_000)) {
      const combinedDuration = group.at(-1)!.endMs - last[0]!.startMs;
      if (combinedDuration <= 130_000 && last.length + group.length <= 20) {
        last.push(...group);
        continue;
      }
    }
    merged.push([...group]);
  }

  return merged.map(buildScene).filter((scene) => scene.wordCount >= 12);
}

function episodeNumberFromKey(key: string): number {
  const filename = key.split('/').pop() ?? key;
  const match = filename.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function titleFromKey(sourceTitle: string, seasonLabel: string | null, key: string): string {
  const episodeNo = episodeNumberFromKey(key);
  const season = seasonLabel ? `${seasonLabel} · ` : '';
  return `${sourceTitle} · ${season}Episode ${String(episodeNo).padStart(2, '0')}`;
}

async function listSrtKeys(env: Env, prefix: string, limit: number): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await env.AUDIO.list({ cursor, prefix });
    keys.push(...listed.objects
      .map((object) => object.key)
      .filter((key) => key.toLowerCase().endsWith('.srt')));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor && keys.length < limit);

  return keys
    .sort((a, b) => episodeNumberFromKey(a) - episodeNumberFromKey(b) || a.localeCompare(b))
    .slice(0, limit);
}

async function upsertSource(env: Env, params: {
  id: string;
  kind: string;
  language: string;
  prefix: string;
  seasonLabel: string | null;
  title: string;
}) {
  await env.DB.prepare(
    `INSERT INTO srt_sources (id, title, kind, r2_prefix, season_label, language, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       kind = excluded.kind,
       r2_prefix = excluded.r2_prefix,
       season_label = excluded.season_label,
       language = excluded.language,
       updated_at = datetime('now')`,
  ).bind(params.id, params.title, params.kind, params.prefix, params.seasonLabel, params.language).run();
}

async function replaceEpisodeScenes(env: Env, params: {
  episodeId: string;
  episodeNo: number;
  key: string;
  scenes: SrtScene[];
  sourceId: string;
  title: string;
  totalDurationSec: number;
  totalLines: number;
}) {
  await env.DB.prepare(
    `INSERT INTO srt_episodes (
       id, source_id, episode_no, title, r2_key, status, line_count, scene_count, duration_sec, updated_at
     )
     VALUES (?, ?, ?, ?, ?, 'parsed', ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       r2_key = excluded.r2_key,
       status = 'parsed',
       line_count = excluded.line_count,
       scene_count = excluded.scene_count,
       duration_sec = excluded.duration_sec,
       updated_at = datetime('now')`,
  ).bind(
    params.episodeId,
    params.sourceId,
    params.episodeNo,
    params.title,
    params.key,
    params.totalLines,
    params.scenes.length,
    params.totalDurationSec,
  ).run();

  await env.DB.prepare(`DELETE FROM srt_scenes WHERE episode_id = ?`).bind(params.episodeId).run();

  for (const [index, scene] of params.scenes.entries()) {
    await env.DB.prepare(
      `INSERT INTO srt_scenes (
         id, episode_id, scene_index, start_ms, end_ms, start_time, end_time, text,
         line_count, word_count, words_per_min, level, difficulty_score, shadowing_score,
         shadowing_json, vocabulary_json, questions_json, status, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'parsed', datetime('now'))`,
    ).bind(
      `${params.episodeId}-s${String(index + 1).padStart(3, '0')}`,
      params.episodeId,
      index + 1,
      scene.startMs,
      scene.endMs,
      scene.startTime,
      scene.endTime,
      scene.text,
      scene.lineCount,
      scene.wordCount,
      scene.wordsPerMin,
      scene.level,
      scene.difficultyScore,
      scene.shadowingScore,
      JSON.stringify(scene.shadowingPrompts),
      JSON.stringify(scene.vocabulary),
    ).run();
  }
}

async function importSrtKey(env: Env, params: {
  key: string;
  seasonLabel: string | null;
  sourceId: string;
  sourceTitle: string;
}) {
  const object = await env.AUDIO.get(params.key);
  if (!object) return { error: 'not_found', key: params.key, ok: false };
  if (object.size > MAX_SRT_BYTES) return { error: 'file_too_large', key: params.key, ok: false };

  const raw = await object.text();
  const cues = parseSrt(raw);
  const scenes = splitScenes(cues);
  const episodeNo = episodeNumberFromKey(params.key);
  const episodeId = `${params.sourceId}-e${String(episodeNo).padStart(2, '0')}`;
  const totalDurationSec = cues.length ? Math.round((cues.at(-1)!.endMs - cues[0]!.startMs) / 1000) : 0;

  await replaceEpisodeScenes(env, {
    episodeId,
    episodeNo,
    key: params.key,
    scenes,
    sourceId: params.sourceId,
    title: titleFromKey(params.sourceTitle, params.seasonLabel, params.key),
    totalDurationSec,
    totalLines: cues.length,
  });

  return {
    episodeId,
    episodeNo,
    key: params.key,
    lineCount: cues.length,
    ok: true,
    sceneCount: scenes.length,
  };
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapSource(row: SourceRow) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    language: row.language,
    r2Prefix: row.r2_prefix,
    seasonLabel: row.season_label,
    episodeCount: row.episode_count,
    readyCount: row.ready_count,
    sceneCount: row.scene_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEpisode(row: EpisodeRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    episodeNo: row.episode_no,
    title: row.title,
    r2Key: row.r2_key,
    status: row.status,
    lineCount: row.line_count,
    sceneCount: row.scene_count,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapScene(row: SceneRow) {
  return {
    id: row.id,
    episodeId: row.episode_id,
    sceneIndex: row.scene_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    startTime: row.start_time,
    endTime: row.end_time,
    text: row.text,
    lineCount: row.line_count,
    wordCount: row.word_count,
    wordsPerMin: row.words_per_min,
    level: row.level,
    difficultyScore: row.difficulty_score,
    shadowingScore: row.shadowing_score,
    status: row.status,
    summaryFr: row.summary_fr,
    shadowingPrompts: parseJsonArray<string>(row.shadowing_json),
    vocabulary: parseJsonArray<string>(row.vocabulary_json),
  };
}

export async function handleImportSrtFolder(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<ImportFolderBody>().catch((): ImportFolderBody => ({}));
  const prefix = normalizePrefix(body.prefix || 'tedLasso/season');
  const title = body.title?.trim() || 'Ted Lasso';
  const sourceId = slugify(body.sourceId || title);
  const limit = Math.max(1, Math.min(MAX_IMPORT_FILES, Math.floor(Number(body.limit ?? MAX_IMPORT_FILES))));
  const seasonLabel = body.seasonLabel?.trim() || 'Saison';

  await upsertSource(env, {
    id: sourceId,
    kind: body.kind?.trim() || 'series',
    language: body.language?.trim() || 'en',
    prefix,
    seasonLabel,
    title,
  });

  const keys = await listSrtKeys(env, prefix, limit);
  const imported = [];
  for (const key of keys) {
    imported.push(await importSrtKey(env, { key, seasonLabel, sourceId, sourceTitle: title }));
  }

  return json({
    ok: true,
    imported,
    prefix,
    sourceId,
    total: imported.length,
  });
}

export async function handleListSrtR2Objects(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const prefix = url.searchParams.get('prefix') ?? 'srt';
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 100)));
  const listed = await env.AUDIO.list({ prefix, limit });

  return json({
    items: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded.toISOString(),
    })),
    ok: true,
    prefix,
    truncated: listed.truncated,
  });
}

export async function handleListSrtSources(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const { results } = await env.DB.prepare(
    `SELECT
       s.id, s.title, s.kind, s.r2_prefix, s.season_label, s.language, s.created_at, s.updated_at,
       COUNT(DISTINCT e.id) AS episode_count,
       SUM(CASE WHEN e.status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
       COUNT(sc.id) AS scene_count
     FROM srt_sources s
     LEFT JOIN srt_episodes e ON e.source_id = s.id
     LEFT JOIN srt_scenes sc ON sc.episode_id = e.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC`,
  ).all<SourceRow>();

  return json({ items: results.map(mapSource), ok: true });
}

export async function handleListSrtEpisodes(req: Request, env: Env, sourceId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const { results } = await env.DB.prepare(
    `SELECT * FROM srt_episodes WHERE source_id = ? ORDER BY episode_no`,
  ).bind(sourceId).all<EpisodeRow>();

  return json({ items: results.map(mapEpisode), ok: true, sourceId });
}

export async function handleListSrtScenes(req: Request, env: Env, episodeId: string): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const level = url.searchParams.get('level');
  const maxDifficulty = Number(url.searchParams.get('maxDifficulty') ?? 100);
  const minShadowing = Number(url.searchParams.get('minShadowing') ?? 0);
  let sql = `SELECT * FROM srt_scenes WHERE episode_id = ?`;
  const binds: Array<string | number> = [episodeId];

  if (level) {
    sql += ` AND level = ?`;
    binds.push(level);
  }
  if (Number.isFinite(maxDifficulty)) {
    sql += ` AND difficulty_score <= ?`;
    binds.push(maxDifficulty);
  }
  if (Number.isFinite(minShadowing)) {
    sql += ` AND shadowing_score >= ?`;
    binds.push(minShadowing);
  }
  sql += ` ORDER BY scene_index`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all<SceneRow>();
  const questions = await loadSceneQuestions(env, results.map((row) => row.id));
  return json({
    episodeId,
    items: results.map((row) => ({ ...mapScene(row), questions: questions.get(row.id) ?? [] })),
    ok: true,
  });
}

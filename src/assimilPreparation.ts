import type { Env } from './types';
import { json, err, isAuthorized } from './utils';
import { handleTranscribeAssimilLesson } from './assimil';
import { TOTAL_LESSONS, levelForIndex, type AssimilLevel } from './assimilModel';

interface PrepareNextOptions {
  force?: boolean;
  limit?: number | string | null;
  provider?: 'auto' | 'deepgram' | 'gemini' | 'openai' | 'runpod';
}

interface PrepareCandidate {
  lesson_index: number;
  level: AssimilLevel;
  status: string | null;
}

interface PreparedLessonResult {
  index: number;
  level: AssimilLevel;
  ok: boolean;
  cached?: boolean;
  error?: string;
  status: number;
}

const DEFAULT_DAILY_LIMIT = 3;
const MAX_BATCH_LIMIT = 3;

function parseLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_LIMIT;
  return Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(parsed)));
}

function doneWhereClause(alias = 'l'): string {
  return `COALESCE(${alias}.status, '') = 'generated'
    AND COALESCE(NULLIF(${alias}.lesson_json, '{}'), '') <> ''`;
}

async function selectNextCandidates(env: Env, limit: number): Promise<PrepareCandidate[]> {
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE seq(lesson_index) AS (
       SELECT 0
       UNION ALL
       SELECT lesson_index + 1 FROM seq WHERE lesson_index + 1 < ?
     )
     SELECT
       seq.lesson_index,
       COALESCE(l.level, '') AS level,
       l.status
     FROM seq
     LEFT JOIN assimil_lessons l ON l.lesson_index = seq.lesson_index
     WHERE NOT (${doneWhereClause('l')})
       AND COALESCE(l.status, '') <> 'transcribing'
     ORDER BY
       CASE COALESCE(l.level, '')
         WHEN 'A1' THEN 1
         WHEN 'A2' THEN 2
         WHEN 'B1' THEN 3
         WHEN 'B2' THEN 4
         ELSE 5
       END,
       seq.lesson_index
     LIMIT ?`,
  ).bind(TOTAL_LESSONS, limit).all<{
    lesson_index: number;
    level: string;
    status: string | null;
  }>();

  return results.map((row) => ({
    lesson_index: row.lesson_index,
    level: (row.level || levelForIndex(row.lesson_index)) as AssimilLevel,
    status: row.status,
  }));
}

async function getPreparationStats(env: Env): Promise<{
  done: boolean;
  generated: number;
  pending: number;
  total: number;
  transcribing: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN ${doneWhereClause('l')} THEN 1 ELSE 0 END) AS generated,
       SUM(CASE WHEN l.status = 'transcribing' THEN 1 ELSE 0 END) AS transcribing
     FROM assimil_lessons l`,
  ).first<{ generated: number | null; transcribing: number | null }>();

  const generated = row?.generated ?? 0;
  const transcribing = row?.transcribing ?? 0;
  const pending = Math.max(0, TOTAL_LESSONS - generated - transcribing);

  return {
    done: generated >= TOTAL_LESSONS,
    generated,
    pending,
    total: TOTAL_LESSONS,
    transcribing,
  };
}

async function prepareCandidate(
  env: Env,
  candidate: PrepareCandidate,
  options: Required<Pick<PrepareNextOptions, 'force' | 'provider'>>,
): Promise<PreparedLessonResult> {
  if (!env.API_SECRET) {
    return {
      error: 'API_SECRET manquant',
      index: candidate.lesson_index,
      level: candidate.level,
      ok: false,
      status: 500,
    };
  }

  const req = new Request(`https://internal/assimil/lesson/${candidate.lesson_index}/transcribe`, {
    body: JSON.stringify({
      force: options.force,
      generate: true,
      provider: options.provider,
    }),
    headers: {
      Authorization: `Bearer ${env.API_SECRET}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const res = await handleTranscribeAssimilLesson(req, env, String(candidate.lesson_index));
  const body: { cached?: boolean; error?: string } = await res
    .json<{ cached?: boolean; error?: string }>()
    .catch(() => ({}));

  return {
    cached: body.cached,
    error: body.error,
    index: candidate.lesson_index,
    level: candidate.level,
    ok: res.ok,
    status: res.status,
  };
}

export async function prepareNextAssimilLessons(
  env: Env,
  options: PrepareNextOptions = {},
): Promise<{
  done: boolean;
  limit: number;
  processed: PreparedLessonResult[];
  selected: number;
  stats: Awaited<ReturnType<typeof getPreparationStats>>;
}> {
  const limit = parseLimit(options.limit);
  const force = options.force ?? false;
  const provider = options.provider ?? 'auto';
  const before = await getPreparationStats(env);

  if (before.done) {
    return { done: true, limit, processed: [], selected: 0, stats: before };
  }

  const candidates = await selectNextCandidates(env, limit);
  const processed: PreparedLessonResult[] = [];

  for (const candidate of candidates) {
    const result = await prepareCandidate(env, candidate, { force, provider });
    processed.push(result);

    // Keep the daily pipeline conservative: one upstream failure should not
    // cascade into multiple expensive retries in the same cron run.
    if (!result.ok) break;
  }

  const stats = await getPreparationStats(env);
  return {
    done: stats.done,
    limit,
    processed,
    selected: candidates.length,
    stats,
  };
}

export async function handleAssimilPrepareNext(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const url = new URL(req.url);
  const body: PrepareNextOptions = await req.json<PrepareNextOptions>().catch(() => ({}));
  const result = await prepareNextAssimilLessons(env, {
    force: body.force ?? url.searchParams.get('force') === 'true',
    limit: body.limit ?? url.searchParams.get('limit'),
    provider: body.provider ?? (url.searchParams.get('provider') as PrepareNextOptions['provider']) ?? 'auto',
  });

  return json({ ok: true, ...result });
}

export async function handleAssimilPreparationStatus(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const stats = await getPreparationStats(env);
  const next = stats.done ? [] : await selectNextCandidates(env, 5);
  return json({ ok: true, next, stats });
}

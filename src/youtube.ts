import type { Env } from './types';
import { err, isAuthorized } from './utils';

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

function proxyYtResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function ytFetch(endpoint: 'search' | 'videos', params: URLSearchParams, keys: string[]): Promise<Response> {
  params.delete('key');
  if (!keys.length) {
    return new Response(JSON.stringify({ error: `YouTube ${endpoint} keys not configured` }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  for (const key of keys) {
    const url = `${YT_BASE}/${endpoint}?${params}&key=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      continue;
    }
    if (res.status !== 403 && res.status !== 429) return proxyYtResponse(res);
  }
  return new Response(JSON.stringify({ error: 'YouTube API quota exceeded on all keys' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export async function handleYouTubeSearch(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const params = new URLSearchParams(new URL(req.url).searchParams);
  const keys = [env.YT_SEARCH_KEY_1, env.YT_SEARCH_KEY_2, env.YT_SEARCH_KEY_3].filter((k): k is string => Boolean(k));
  return ytFetch('search', params, keys);
}

export async function handleYouTubeVideos(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const params = new URLSearchParams(new URL(req.url).searchParams);
  const keys = [env.YT_READ_KEY_1, env.YT_READ_KEY_2, env.YT_READ_KEY_3].filter((k): k is string => Boolean(k));
  return ytFetch('videos', params, keys);
}

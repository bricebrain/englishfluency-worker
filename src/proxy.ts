/**
 * Proxy transparent vers les APIs IA.
 * L'app envoie sa requête au Worker, le Worker la retransmet avec la vraie clé.
 * Les clés sont des wrangler secrets — elles ne quittent jamais Cloudflare.
 * L'appel exige le secret du Worker : sans lui, n'importe qui pourrait
 * consommer les crédits IA en connaissant l'adresse du Worker.
 */

import type { Env } from './types';
import { err, isAuthorized } from './utils';

type ProxyTarget = 'openai' | 'openrouter' | 'gemini' | 'groq' | 'deepseek' | 'xai';

const TARGET_URLS: Record<ProxyTarget, string> = {
  openai:      'https://api.openai.com',
  openrouter:  'https://openrouter.ai/api',
  gemini:      'https://generativelanguage.googleapis.com',
  groq:        'https://api.groq.com',
  deepseek:    'https://api.deepseek.com',
  xai:         'https://api.x.ai',
};

async function getApiKey(target: ProxyTarget, env: Env): Promise<string | undefined> {
  switch (target) {
    case 'openai':     return env.OPENAI_API_KEY.get();
    case 'openrouter': return env.OPENROUTER_API_KEY.get();
    case 'gemini':     return env.GEMINI_API_KEY.get();
    case 'groq':       return (await env.GROQ_API_KEY_1.get()) || env.GROQ_API_KEY_2.get();
    case 'deepseek':   return env.DEEPSEEK_API_KEY.get();
    case 'xai':        return env.XAI_API_KEY.get();
  }
}

/**
 * Proxifie une requête vers l'API cible.
 * Route attendue : /proxy/<target>/<reste-du-chemin>
 * Ex : /proxy/openai/v1/audio/speech
 *      /proxy/gemini/v1beta/models/gemini-2.5-flash-preview-tts:generateContent
 */
export async function handleProxy(
  req: Request,
  env: Env,
  pathAfterProxy: string,
): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const [target, ...rest] = pathAfterProxy.split('/');

  if (!isValidTarget(target)) {
    return err(`Cible inconnue : ${target}. Cibles valides : openai, openrouter, gemini, groq, deepseek, xai`, 400);
  }

  const apiKey = await getApiKey(target, env);
  if (!apiKey) {
    return err(`Clé non configurée pour : ${target}`, 503);
  }

  const upstreamPath = '/' + rest.join('/');
  const originalUrl = new URL(req.url);
  const upstreamUrl = TARGET_URLS[target] + upstreamPath + (originalUrl.search ?? '');

  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  headers.delete('Authorization');

  if (target === 'gemini' && upstreamPath.includes('/openai/')) {
    // Endpoint OpenAI-compatible de Gemini → Bearer
    headers.set('Authorization', `Bearer ${apiKey}`);
  } else if (target === 'gemini') {
    // API native Gemini → ?key= dans l'URL
    const url = new URL(upstreamUrl);
    url.searchParams.set('key', apiKey);
    const upstreamReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
    });
    const res = await fetch(upstreamReq);
    return proxyResponse(res);
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
  }

  const upstreamReq = new Request(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
  });

  const res = await fetch(upstreamReq);
  return proxyResponse(res);
}

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function isValidTarget(value: string): value is ProxyTarget {
  return value in TARGET_URLS;
}

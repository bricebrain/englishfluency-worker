/**
 * TTS avec cache R2
 * POST /tts/openai  — génère + cache → retourne { audioUrl }
 * POST /tts/gemini  — génère + cache → retourne { audioUrl }
 * GET  /audio/:key  — sert le fichier depuis R2
 */

import type { Env } from './types';
import { err } from './utils';

const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

// ── Helpers ────────────────────────────────────────────────────────────────

function toHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i);
  return Math.abs(h >>> 0).toString(36);
}

function jsonResp(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  const cleaned = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = cleaned.length;
  let outLen = (len * 3) >> 2;
  if (cleaned[len - 1] === '=') outLen--;
  if (cleaned[len - 2] === '=') outLen--;
  const bytes = new Uint8Array(outLen);
  let j = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[cleaned.charCodeAt(i)] ?? 0;
    const b = lookup[cleaned.charCodeAt(i + 1)] ?? 0;
    const c = lookup[cleaned.charCodeAt(i + 2)] ?? 0;
    const d = lookup[cleaned.charCodeAt(i + 3)] ?? 0;
    bytes[j++] = (a << 2) | (b >> 4);
    if (j < outLen) bytes[j++] = ((b & 0xf) << 4) | (c >> 2);
    if (j < outLen) bytes[j++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

function pcmToWav(pcmBase64: string): Uint8Array {
  const pcm = base64ToBytes(pcmBase64);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + pcm.length, true);
  header.set([0x57, 0x41, 0x56, 0x45], 8);
  header.set([0x66, 0x6d, 0x74, 0x20], 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8, true);
  view.setUint16(32, (CHANNELS * BITS_PER_SAMPLE) / 8, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  header.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, pcm.length, true);
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, 44);
  return wav;
}

// ── POST /tts/openai ────────────────────────────────────────────────────────

export async function handleTtsOpenAi(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{
    text: string; voice?: string; instructions?: string; model?: string;
  }>().catch(() => null);

  if (!body?.text) return err('text requis');

  const voice = body.voice ?? 'coral';
  const model = body.model ?? OPENAI_TTS_MODEL;
  const instructions = body.instructions ?? '';
  const hash = toHash(`openai|${model}|${voice}|${instructions}|${body.text}`);
  const r2Key = `tts/openai/${hash}.mp3`;

  // Vérif cache R2
  const cached = await env.AUDIO.head(r2Key);
  if (cached) {
    return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: true });
  }

  const apiKey = await env.OPENAI_API_KEY.get();
  if (!apiKey) return err('Clé OpenAI non configurée', 503);

  const payload: Record<string, string> = { model, voice, input: body.text };
  if (instructions) payload.instructions = instructions;

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return err(`OpenAI TTS erreur: ${res.status}`, 502);

  const audioBuffer = await res.arrayBuffer();

  // Sauvegarde R2
  await env.AUDIO.put(r2Key, audioBuffer, {
    httpMetadata: { contentType: 'audio/mpeg' },
  });

  return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: false });
}

// ── POST /tts/gemini ────────────────────────────────────────────────────────

export async function handleTtsGemini(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ text: string; voice?: string; model?: string }>().catch(() => null);
  if (!body?.text) return err('text requis');

  const voice = body.voice ?? 'Aoede';
  const model = body.model ?? GEMINI_TTS_MODEL;
  const hash = toHash(`gemini|${model}|${voice}|${body.text}`);
  const r2Key = `tts/gemini/${hash}.wav`;

  // Vérif cache R2
  const cached = await env.AUDIO.head(r2Key);
  if (cached) {
    return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: true });
  }

  const apiKey = await env.GEMINI_API_KEY.get();
  if (!apiKey) return err('Clé Gemini non configurée', 503);

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: body.text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });

  if (!res.ok) return err(`Gemini TTS erreur: ${res.status}`, 502);

  const json = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const pcmBase64 = json.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!pcmBase64) return err('Gemini TTS: aucune donnée audio', 502);

  const wavBytes = pcmToWav(pcmBase64);

  await env.AUDIO.put(r2Key, wavBytes, {
    httpMetadata: { contentType: 'audio/wav' },
  });

  return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: false });
}

// ── POST /tts/groq ─────────────────────────────────────────────────────────

export async function handleTtsGroq(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ text: string; voice?: string; model?: string }>().catch(() => null);
  if (!body?.text) return err('text requis');

  const voice = body.voice ?? 'autumn';
  const model = body.model ?? 'canopylabs/orpheus-v1-english';
  const hash = toHash(`groq|${model}|${voice}|${body.text}`);
  const r2Key = `tts/groq/${hash}.wav`;

  // Vérif cache R2
  const cached = await env.AUDIO.head(r2Key);
  if (cached) {
    return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: true });
  }

  const apiKey = (await env.GROQ_API_KEY_1.get()) || (await env.GROQ_API_KEY_2.get());
  if (!apiKey) return err('Clé Groq non configurée', 503);

  const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, voice, response_format: 'wav', input: body.text }),
  });

  if (!res.ok) return err(`Groq TTS erreur: ${res.status}`, 502);

  const audioBuffer = await res.arrayBuffer();
  await env.AUDIO.put(r2Key, audioBuffer, { httpMetadata: { contentType: 'audio/wav' } });

  return jsonResp({ audioUrl: `/audio/${r2Key}`, cached: false });
}

// ── GET /audio/:key (sert depuis R2) ────────────────────────────────────────

export async function handleServeAudio(_req: Request, env: Env, key: string): Promise<Response> {
  const object = await env.AUDIO.get(key);
  if (!object) {
    return new Response('Audio introuvable', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const contentType = object.httpMetadata?.contentType ?? (key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg');

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

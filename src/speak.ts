/**
 * Module Parler — transcription + analyse d'un enregistrement vocal
 *
 * POST /speak/analyze   multipart/form-data
 *   audio : File        — enregistrement (audio/m4a | audio/mp4 | audio/webm)
 *   prompt: string      — phrase à répéter OU question à répondre
 *   level : string      — CEFR (A2 | B1 | B2 | C1)
 *   type  : 'repeat' | 'respond'
 *
 * Providers (pas de Groq — quota limité) :
 *   Primary  : Gemini 2.5 Flash  — transcription + analyse en un seul appel
 *   Fallback : OpenAI Whisper    — transcription seule
 *              + GPT-4o-mini     — analyse du transcript
 */

import type { Env } from './types';
import { err, json } from './utils';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpeakAnalysis {
  transcript:      string;
  score:           number;
  fluency:         string;
  corrections:     Array<{ original: string; corrected: string; note: string }>;
  vocabulary_tips: string[];
  encouragement:   string;
  source:          'gemini' | 'openai';
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode Uint8Array → base64 sans dépasser la stack (chunks de 8 Ko). */
function toBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? raw;
  const first = candidate.indexOf('{');
  const last  = candidate.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try { return JSON.parse(candidate.slice(first, last + 1)) as Record<string, unknown>; }
  catch { return null; }
}

function parseAnalysis(raw: string, source: 'gemini' | 'openai'): SpeakAnalysis | null {
  const obj = extractJson(raw);
  if (!obj) return null;
  const transcript = typeof obj.transcript === 'string' ? obj.transcript.trim() : '';
  if (!transcript) return null;
  return {
    transcript,
    score:           typeof obj.score === 'number'
      ? Math.min(100, Math.max(0, Math.round(obj.score))) : 60,
    fluency:         typeof obj.fluency === 'string' ? obj.fluency : '',
    corrections:     Array.isArray(obj.corrections)
      ? (obj.corrections as unknown[])
          .filter((c): c is { original: string; corrected: string; note: string } =>
            typeof c === 'object' && c !== null && 'corrected' in c)
      : [],
    vocabulary_tips: Array.isArray(obj.vocabulary_tips)
      ? (obj.vocabulary_tips as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    encouragement:   typeof obj.encouragement === 'string' ? obj.encouragement : 'Continue comme ça !',
    source,
  };
}

function buildAnalysisPrompt(
  promptText: string,
  level: string,
  type: 'repeat' | 'respond',
): string {
  const task = type === 'repeat'
    ? `The learner was asked to repeat this phrase exactly: "${promptText}"`
    : `The learner was asked this question in English: "${promptText}"`;
  return [
    `You are an English speaking coach for French learners (CEFR level: ${level}).`,
    task,
    '',
    'Listen to the audio recording and:',
    '1. Transcribe EXACTLY what was said (preserve errors).',
    type === 'repeat'
      ? '2. Compare to the target phrase. Evaluate accuracy and pronunciation.'
      : '2. Evaluate grammar, vocabulary range, and fluency.',
    '',
    'Return ONLY this JSON (no markdown wrapper):',
    '{',
    '  "transcript": "<exact transcription>",',
    '  "score": <integer 0-100>,',
    '  "fluency": "<one sentence about fluency in French>",',
    '  "corrections": [{ "original": "...", "corrected": "...", "note": "<French explanation>" }],',
    '  "vocabulary_tips": ["<tip in French>"],',
    '  "encouragement": "<one motivating sentence in French>"',
    '}',
  ].join('\n');
}

// ── Primary: Gemini 2.5 Flash (audio inline → transcription + analyse) ─────

async function analyzeWithGemini(
  audioBytes: Uint8Array,
  mimeType:   string,
  prompt:     string,
  level:      string,
  type:       'repeat' | 'respond',
  apiKey:     string,
): Promise<SpeakAnalysis | null> {
  const model = 'gemini-2.5-flash-preview-04-17';
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType || 'audio/m4a', data: toBase64(audioBytes) } },
          { text: buildAnalysisPrompt(prompt, level, type) },
        ],
      }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
    }),
  });

  if (!res.ok) return null;
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return parseAnalysis(text, 'gemini');
}

// ── Fallback: OpenAI Whisper (transcription) + GPT-4o-mini (analyse) ───────

async function transcribeWithWhisper(audioFile: File, apiKey: string): Promise<string | null> {
  const form = new FormData();
  form.append('file', audioFile);
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return null;
  const data = await res.json() as { text?: string };
  return data.text?.trim() ?? null;
}

async function analyzeTranscriptWithGpt(
  transcript:  string,
  prompt:      string,
  level:       string,
  type:        'repeat' | 'respond',
  apiKey:      string,
): Promise<SpeakAnalysis | null> {
  const task = type === 'repeat'
    ? `The learner was asked to repeat: "${prompt}". They said: "${transcript}"`
    : `Question asked: "${prompt}". Learner's answer: "${transcript}"`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          `English speaking coach for French learners (CEFR ${level}).`,
          task,
          '',
          'Evaluate and return ONLY this JSON:',
          '{ "transcript": "...", "score": 0-100, "fluency": "...", "corrections": [{...}], "vocabulary_tips": ["..."], "encouragement": "..." }',
        ].join('\n'),
      }],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (!text) return null;
  // inject transcript since GPT-4o-mini tends to paraphrase
  const parsed = parseAnalysis(text, 'openai');
  if (parsed) parsed.transcript = transcript;
  return parsed;
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleSpeakAnalyze(req: Request, env: Env): Promise<Response> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('multipart/form-data')) return err('multipart/form-data requis', 400);

  let form: FormData;
  try { form = await req.formData(); }
  catch { return err('Impossible de parser le form-data', 400); }

  const audioRaw = form.get('audio');
  // CF Workers : File n'est pas un constructeur, on discrimine par typeof
  if (audioRaw === null || typeof audioRaw === 'string') return err('Champ "audio" manquant', 400);
  const audioFile = audioRaw as File;
  if (audioFile.size < 1000) return err('Enregistrement trop court', 400);

  const prompt   = String(form.get('prompt') ?? '').slice(0, 500);
  const level    = String(form.get('level')  ?? 'B1');
  const typeRaw  = String(form.get('type')   ?? 'respond');
  const type     = typeRaw === 'repeat' ? 'repeat' as const : 'respond' as const;
  const mimeType = audioFile.type || 'audio/m4a';

  // ── Primary: Gemini ───────────────────────────────────────────────────
  try {
    const geminiKey = await env.GEMINI_API_KEY.get();
    if (geminiKey) {
      const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
      const result = await analyzeWithGemini(audioBytes, mimeType, prompt, level, type, geminiKey);
      if (result) return json(result);
    }
  } catch { /* fallback */ }

  // ── Fallback: OpenAI Whisper → GPT-4o-mini ────────────────────────────
  try {
    const openAiKey = await env.OPENAI_API_KEY.get();
    if (openAiKey) {
      const transcript = await transcribeWithWhisper(audioFile, openAiKey);
      if (transcript) {
        const result = await analyzeTranscriptWithGpt(transcript, prompt, level, type, openAiKey);
        if (result) return json(result);
        // au pire renvoyer juste le transcript
        return json({
          transcript,
          score: 65,
          fluency: '',
          corrections: [],
          vocabulary_tips: [],
          encouragement: 'Continue à pratiquer !',
          source: 'openai',
        } satisfies SpeakAnalysis);
      }
    }
  } catch { /* fallthrough */ }

  return err('Analyse vocale indisponible', 503);
}

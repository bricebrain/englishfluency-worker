import { MODELS, cleanString, cleanStringList, extractJsonObject, runChat } from './aiBudget';
import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

/**
 * POST /live/analyze — analyse d'un bilan de séance Live (ChatGPT) collé par
 * l'utilisateur : points forts, erreurs récurrentes corrigées et expressions à
 * revoir, prêtes à être ajoutées au SRS par la PWA (route /articles/promote-words).
 */

const MAX_REPORT = 8000;

export interface LiveAnalysis {
  summaryFr: string;
  strengths: string[];
  errors: { wrong: string; correct: string; explanationFr: string }[];
  expressions: { en: string; fr: string; example: string }[];
}

const SCHEMA = {
  type: 'object',
  properties: {
    summaryFr: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    errors: {
      type: 'array',
      items: { type: 'object', properties: { wrong: { type: 'string' }, correct: { type: 'string' }, explanationFr: { type: 'string' } }, required: ['wrong', 'correct', 'explanationFr'] },
    },
    expressions: {
      type: 'array',
      items: { type: 'object', properties: { en: { type: 'string' }, fr: { type: 'string' }, example: { type: 'string' } }, required: ['en', 'fr', 'example'] },
    },
  },
  required: ['summaryFr', 'strengths', 'errors', 'expressions'],
};

export function normalizeLiveAnalysis(raw: unknown): LiveAnalysis | null {
  const data = extractJsonObject(raw);
  if (!data) return null;
  const errors = (Array.isArray(data.errors) ? data.errors as Record<string, unknown>[] : [])
    .map((item) => ({ wrong: cleanString(item?.wrong, 200), correct: cleanString(item?.correct, 200), explanationFr: cleanString(item?.explanationFr, 300) }))
    .filter((item) => item.wrong && item.correct && item.wrong.toLowerCase() !== item.correct.toLowerCase())
    .slice(0, 8);
  const seen = new Set<string>();
  const expressions = (Array.isArray(data.expressions) ? data.expressions as Record<string, unknown>[] : [])
    .map((item) => ({ en: cleanString(item?.en, 80), fr: cleanString(item?.fr, 120), example: cleanString(item?.example, 220) }))
    .filter((item) => {
      const key = item.en.toLowerCase();
      if (!item.en || !item.fr || item.en.split(/\s+/).length > 8 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
  const summaryFr = cleanString(data.summaryFr, 600);
  if (!summaryFr && !errors.length && !expressions.length) return null;
  return { summaryFr, strengths: cleanStringList(data.strengths, 5, 200), errors, expressions };
}

export async function handleLiveAnalyze(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);
  const body = await req.json<{ profileId?: unknown; report?: unknown }>().catch(() => null);
  const profileId = cleanString(body?.profileId, 80) || 'default';
  const report = typeof body?.report === 'string' ? body.report.trim().slice(0, MAX_REPORT) : '';
  if (report.length < 40) return err('Bilan trop court');

  try {
    const raw = await runChat(env, MODELS.quality, [
      { role: 'system', content: 'Tu es un coach d’anglais pour un francophone. Tu analyses le bilan d’une conversation orale. Réponds seulement en JSON valide.' },
      {
        role: 'user',
        content: [
          'Voici le bilan d’une séance de conversation en anglais :',
          `"""${report}"""`,
          'Extrais :',
          '- "summaryFr" : 2 phrases de synthèse en français ;',
          '- "strengths" : les points forts, en français ;',
          '- "errors" : les erreurs récurrentes, chacune avec la forme fautive ("wrong"), la forme correcte ("correct") et une explication courte en français ;',
          '- "expressions" : les mots ou expressions anglaises à revoir (2 à 6 mots maximum chacun), avec leur traduction française ("fr") et un exemple anglais naturel ("example").',
          'N’invente rien qui ne soit pas dans le bilan.',
        ].join('\n'),
      },
    ], { temperature: 0.2, maxTokens: 1400, jsonSchema: SCHEMA });
    const analysis = normalizeLiveAnalysis(raw);
    if (!analysis) return json({ error: 'Analyse inexploitable' }, 502);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO live_report_analyses (id, profile_id, report, analysis_json, model) VALUES (?, ?, ?, ?, ?)')
      .bind(id, profileId, report, JSON.stringify(analysis), MODELS.quality).run();
    return json({ id, analysis });
  } catch (error) {
    console.warn('live/analyze', error instanceof Error ? error.message : error);
    return err('Analyse indisponible', 502);
  }
}

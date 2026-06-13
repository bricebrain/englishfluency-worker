import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

interface SpeakCorrectionInput {
  corrected?: string;
  note?: string;
  original?: string;
}

interface PromoteSpeakFeedbackRequest {
  corrections: SpeakCorrectionInput[];
  level: string;
  profileId: string;
  prompt?: string;
}

function normalizeLevel(level: string): string {
  const upper = level.toUpperCase();
  return ['A1', 'A2', 'B1', 'B2', 'C1'].includes(upper) ? upper : 'B1';
}

function cleanExpression(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.,;:!?()-]+|[\s"'`.,;:!?()-]+$/g, '')
    .trim();
}

function isReusableExpression(value: string): boolean {
  const tokenCount = value.split(/\s+/).filter(Boolean).length;
  return tokenCount >= 1 && tokenCount <= 8 && value.length <= 80;
}

function buildDefinition(note: string | undefined, original: string | undefined): string {
  const fallback = original?.trim() ? `A retravailler: ${original.trim()}` : 'Expression a reutiliser';
  const value = note?.trim() || fallback;
  return value.slice(0, 160);
}

export async function handlePromoteSpeakFeedback(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<PromoteSpeakFeedbackRequest>().catch(() => null);
  if (!body?.profileId || !Array.isArray(body?.corrections) || body.corrections.length === 0) {
    return err('profileId et corrections requis', 400);
  }

  const level = normalizeLevel(body.level ?? 'B1');
  const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : 'Speaking correction';
  const uniqueExpressions = new Set<string>();
  let promoted = 0;
  let created = 0;
  let skipped = 0;

  for (const item of body.corrections.slice(0, 4)) {
    const corrected = cleanExpression(item.corrected ?? '');
    if (!corrected || !isReusableExpression(corrected)) {
      skipped += 1;
      continue;
    }

    const key = corrected.toLowerCase();
    if (uniqueExpressions.has(key)) {
      skipped += 1;
      continue;
    }
    uniqueExpressions.add(key);

    const existing = await env.DB.prepare(
      'SELECT id FROM words WHERE LOWER(mot) = LOWER(?) LIMIT 1',
    ).bind(corrected).first<{ id: string }>();

    let wordId: string;
    if (existing) {
      wordId = existing.id;
    } else {
      wordId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR IGNORE INTO words (id, mot, type, niveau, traduction, examples, audio_uk, audio_us, frequence)
        VALUES (?, ?, 'expression', ?, ?, ?, '', '', 2)
      `).bind(
        wordId,
        corrected,
        level,
        buildDefinition(item.note, item.original),
        JSON.stringify([{ en: corrected, fr: prompt.slice(0, 160) }]),
      ).run();
      created += 1;
    }

    const progressId = `${body.profileId}_${wordId}`;
    await env.DB.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, intervalle, facilite, repetitions,
        derniere_revision, seen_count, success_count, almost_count, fail_count,
        level, status, review_history, updated_at
      ) VALUES (?, ?, ?, datetime('now'), 0, 2.5, 1, datetime('now'), 1, 0, 0, 0, 1, 'learning', '[]', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        prochaine_revision = datetime('now'),
        status = 'learning',
        updated_at = datetime('now')
    `).bind(progressId, body.profileId, wordId).run();

    promoted += 1;
  }

  return json({ ok: true, promoted, created, skipped });
}

import type { Env } from './types';
import { err, isAuthorized, json } from './utils';

interface PromotePodcastWord {
  example?: string;
  term: string;
}

interface PromotePodcastWordsRequest {
  level: string;
  podcastTitle?: string;
  profileId: string;
  vocabulary: PromotePodcastWord[];
}

function normalizeLevel(level: string): string {
  const upper = level.toUpperCase();
  return ['A1', 'A2', 'B1', 'B2', 'C1'].includes(upper) ? upper : 'B1';
}

export async function handlePromotePodcastWords(req: Request, env: Env): Promise<Response> {
  if (!isAuthorized(req, env.API_SECRET)) return err('Non autorisé', 401);

  const body = await req.json<PromotePodcastWordsRequest>().catch(() => null);
  if (!body?.profileId || !Array.isArray(body?.vocabulary) || body.vocabulary.length === 0) {
    return err('profileId et vocabulary requis', 400);
  }

  const level = normalizeLevel(body.level ?? 'B1');
  const sourceTitle = typeof body.podcastTitle === 'string' && body.podcastTitle.trim()
    ? body.podcastTitle.trim()
    : 'Podcast du jour';

  let promoted = 0;
  let created = 0;
  let skipped = 0;

  for (const item of body.vocabulary.slice(0, 5)) {
    const term = (item.term ?? '').trim();
    if (!term) {
      skipped += 1;
      continue;
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM words WHERE LOWER(mot) = LOWER(?) LIMIT 1',
    ).bind(term).first<{ id: string }>();

    let wordId: string;
    if (existing) {
      wordId = existing.id;
    } else {
      wordId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT OR IGNORE INTO words (id, mot, type, niveau, traduction, examples, audio_uk, audio_us, frequence)
        VALUES (?, ?, 'noun', ?, ?, ?, '', '', 3)
      `).bind(
        wordId,
        term,
        level,
        `Mot cle du podcast: ${sourceTitle}`.slice(0, 160),
        JSON.stringify([{ en: item.example?.trim() || term, fr: sourceTitle.slice(0, 160) }]),
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

/**
 * Non-régression — SRS, Lingvist, tri et mémoire pédagogique : routes
 * appelées par la PWA (src/api/learningApi.ts), avec ses payloads exacts.
 */
import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

function unMot(db: ReturnType<typeof createEnv>['db'], niveau = 'A2') {
  return db.sqlite.prepare('SELECT id, mot FROM words WHERE niveau = ? ORDER BY id LIMIT 1').get(niveau) as { id: string; mot: string };
}

const progression = (overrides: Record<string, unknown> = {}) => ({
  prochaine_revision: '2026-10-20T00:00:00Z', intervalle: 1, facilite: 2.5, repetitions: 1,
  derniere_revision: '2026-10-16T00:00:00Z', seen_count: 1, success_count: 1, almost_count: 0,
  fail_count: 0, level: 1, status: 'learning', review_history: [], ...overrides,
});

describe('GET /srs/stats et /srs/session', () => {
  it('renvoie les compteurs attendus par le tableau de bord', async () => {
    const { env } = createEnv();
    const response = await call(env, '/srs/stats?profileId=default');
    expect(response.status).toBe(200);
    const stats = await response.json();
    expect(Object.keys(stats).sort()).toEqual(['dueCount', 'learnedCount', 'newCount', 'reviewedToday', 'streak', 'totalCount']);
    expect(stats.totalCount).toBeGreaterThan(4000);
  });

  it('renvoie des mots avec traduction et exemples', async () => {
    const { env } = createEnv();
    const response = await call(env, '/srs/session?profileId=default&limit=3');
    expect(response.status).toBe(200);
    const { words } = await response.json() as { words: Array<Record<string, unknown>> };
    expect(words.length).toBeGreaterThan(0);
    expect(words[0]).toEqual(expect.objectContaining({ id: expect.any(String), mot: expect.any(String), traduction: expect.any(String), examples: expect.any(Array) }));
  });
});

describe('POST /srs/review (payload de la PWA)', () => {
  it('enregistre la progression et l’historique du jour', async () => {
    const { env, db } = createEnv();
    const mot = unMot(db);
    const response = await call(env, '/srs/review', {
      method: 'POST',
      body: { profileId: 'default', wordId: mot.id, word: { id: mot.id, mot: mot.mot, ...progression(), lastGrade: 'good' }, day: '2026-10-16', count: 1, result: 'success' },
    });
    expect(response.status).toBe(200);
    const ligne = db.sqlite.prepare('SELECT status, intervalle FROM word_progress WHERE id = ?').get(`default_${mot.id}`) as { status: string };
    expect(ligne.status).toBe('learning');
    const jour = db.sqlite.prepare("SELECT count FROM review_history_daily WHERE id = 'default_2026-10-16'").get() as { count: number };
    expect(jour.count).toBe(1);
  });

  it('refuse sans clé', async () => {
    const { env, db } = createEnv();
    const mot = unMot(db);
    const response = await call(env, '/srs/review', { method: 'POST', auth: false, body: { profileId: 'default', wordId: mot.id, word: progression(), day: '2026-10-16', count: 1 } });
    expect(response.status).toBe(401);
  });
});

describe('Tri et mots connus', () => {
  it('GET /srs/triage propose des candidats', async () => {
    const { env } = createEnv();
    const response = await call(env, '/srs/triage?profileId=default&limit=5');
    expect(response.status).toBe(200);
    const { words } = await response.json() as { words: unknown[] };
    expect(words.length).toBeGreaterThan(0);
  });

  it('POST /srs/known marque un mot connu une seule fois', async () => {
    const { env, db } = createEnv();
    const mot = unMot(db);
    const premier = await call(env, '/srs/known', { method: 'POST', body: { profileId: 'default', wordIds: [mot.id] } });
    expect(await premier.json()).toMatchObject({ ok: true, updated: 1 });
    const second = await call(env, '/srs/known', { method: 'POST', body: { profileId: 'default', wordIds: [mot.id] } });
    expect(second.status).toBe(200);
  });
});

describe('POST /articles/promote-words (passerelle lecture → SRS)', () => {
  it('crée l’expression inconnue et la rend due immédiatement', async () => {
    const { env, db } = createEnv();
    const response = await call(env, '/articles/promote-words', {
      method: 'POST',
      body: { profileId: 'default', level: 'B1', vocabulary: [{ term: 'slip one’s mind', definition_fr: 'sortir de la tête', example: 'It slipped my mind.' }] },
    });
    expect(await response.json()).toMatchObject({ ok: true, promoted: 1, created: 1 });
    const mot = db.sqlite.prepare("SELECT id FROM words WHERE mot = 'slip one’s mind'").get() as { id: string };
    const due = db.sqlite.prepare('SELECT status FROM word_progress WHERE id = ?').get(`default_${mot.id}`) as { status: string };
    expect(due.status).toBe('learning');
  });

  it('réutilise un mot existant au lieu de le dupliquer', async () => {
    const { env, db } = createEnv();
    const mot = unMot(db);
    await call(env, '/articles/promote-words', { method: 'POST', body: { profileId: 'default', level: 'B1', vocabulary: [{ term: mot.mot.toUpperCase(), definition_fr: 'x', example: 'x' }] } });
    const total = db.sqlite.prepare('SELECT COUNT(*) AS n FROM words WHERE LOWER(mot) = LOWER(?)').get(mot.mot) as { n: number };
    expect(total.n).toBe(1);
  });
});

describe('Mémoire pédagogique', () => {
  it('POST /learning/events enregistre un événement d’écoute', async () => {
    const { env, db } = createEnv();
    const response = await call(env, '/learning/events', {
      method: 'POST',
      body: { profileId: 'default', module: 'listen', eventType: 'podcast_completed', skill: 'listening', contentId: 'cyber', score: 0.8, payload: { title: 'Cyber' } },
    });
    expect(response.status).toBe(200);
    const ligne = db.sqlite.prepare("SELECT module, event_type FROM learning_events WHERE content_id = 'cyber'").get();
    expect(ligne).toMatchObject({ module: 'listen', event_type: 'podcast_completed' });
  });

  it('GET /learning/mission répond pour un profil neuf', async () => {
    const { env } = createEnv();
    expect((await call(env, '/learning/mission?profileId=default')).status).toBe(200);
  });
});

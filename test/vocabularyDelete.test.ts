import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

function firstWord(db: ReturnType<typeof createEnv>['db']) {
  return db.sqlite.prepare('SELECT id, mot FROM words ORDER BY id LIMIT 1').get() as {
    id: string;
    mot: string;
  };
}

describe('DELETE /words', () => {
  it('refuse une suppression sans authentification', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db);
    const response = await call(env, '/words', {
      method: 'DELETE', auth: false, body: { ids: [word.id] },
    });
    expect(response.status).toBe(401);
    expect(firstWord(db).id).toBe(word.id);
  });

  it('supprime les mots et leurs données liées dans un même lot', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db);
    db.sqlite.prepare(`
      INSERT INTO word_progress (
        id, profile_id, word_id, prochaine_revision, review_history
      ) VALUES (?, 'default', ?, datetime('now'), '[]')
    `).run(`default_${word.id}`, word.id);
    db.sqlite.prepare(`
      INSERT INTO lingvist_cards (
        id, profile_id, word_id, example_en, lemma, expected_answer,
        sentence_with_gap, sentence_full, translation_fr, grammar_hint,
        input_placeholder
      ) VALUES (?, 'default', ?, 'Example', ?, ?, '_', 'Example',
        'Exemple', '', '')
    `).run(`default_${word.id}`, word.id, word.mot, word.mot);

    const response = await call(env, '/words', {
      method: 'DELETE', body: { ids: [word.id] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true, deleted: 1,
      related: { wordProgress: 1, lingvistCards: 1 },
    });
    expect(db.sqlite.prepare('SELECT id FROM words WHERE id = ?').get(word.id)).toBeUndefined();
    expect(db.sqlite.prepare('SELECT id FROM word_progress WHERE word_id = ?').get(word.id)).toBeUndefined();
    expect(db.sqlite.prepare('SELECT id FROM lingvist_cards WHERE word_id = ?').get(word.id)).toBeUndefined();
  });

  it('ne supprime rien si un identifiant du lot est introuvable', async () => {
    const { env, db } = createEnv();
    const word = firstWord(db);
    const response = await call(env, '/words', {
      method: 'DELETE', body: { ids: [word.id, 'missing_9999'] },
    });
    expect(response.status).toBe(409);
    expect(db.sqlite.prepare('SELECT id FROM words WHERE id = ?').get(word.id)).toBeDefined();
  });
});

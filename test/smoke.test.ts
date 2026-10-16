import { describe, expect, it } from 'vitest';

import { call, createEnv } from './support/env';

describe('environnement de test', () => {
  it('applique toutes les migrations et répond sur /', async () => {
    const { env, db } = createEnv();
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => (t as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(['content', 'words', 'word_progress', 'learning_events', 'lingvist_cards']));
    const response = await call(env, '/');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });
});

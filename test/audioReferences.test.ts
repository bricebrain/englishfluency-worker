/**
 * LOT 1 — références audio et nettoyage contrôlé (écoute active v1.2 § 8.2,
 * critères EA-06, EA-07, EA-19, EA-20, EA-21).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { cleanupAudioReferences } from '../src/audioReferences';
import { call, createEnv } from './support/env';

const MP3 = new Uint8Array([0x49, 0x44, 0x33, ...new Array(1021).fill(7)]);
const key = (id: string, revision: string) => `prepared-content/${id}-faithful-${revision}.mp3`;
const DAY = 24 * 3600 * 1000;

type Env = ReturnType<typeof createEnv>;

function payload(id: string, audioR2Key: string | null) {
  return { profileId: 'default', id, type: 'podcast', title: id, body: 'Hello.', audioR2Key, metadata: { schemaVersion: 2 } };
}

async function upload(env: Env['env'], id: string, k: string) {
  return call(env, `/content/audio?key=${encodeURIComponent(k)}&contentId=${id}`, { method: 'POST', body: MP3 });
}

async function publish(env: Env['env'], id: string, k: string | null) {
  const response = await call(env, '/content', { method: 'POST', body: payload(id, k) });
  expect(response.status).toBe(200);
}

async function refs({ db }: Env, k: string) {
  const { results } = await db.prepare('SELECT kind, ref_id, state, content_id FROM audio_references WHERE key = ? ORDER BY kind')
    .bind(k).all<{ kind: string; ref_id: string; state: string; content_id: string }>();
  return results;
}

/** Vieillit artificiellement toutes les références (simulation du temps). */
function age({ db }: Env, ms: number) {
  const past = new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
  db.sqlite.prepare('UPDATE audio_references SET updated_at = ?, retired_at = CASE WHEN retired_at IS NULL THEN NULL ELSE ? END').run(past, past);
}

describe('upload avec contentId', () => {
  it('enregistre la clé en pending', async () => {
    const t = createEnv();
    const response = await upload(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: 'pending' });
    expect(await refs(t, key('cyber', '1a2b3c4d'))).toEqual([{ kind: 'content', ref_id: 'cyber', state: 'pending', content_id: 'cyber' }]);
  });

  it('refuse une clé qui ne commence pas par prepared-content/<contentId>-', async () => {
    const t = createEnv();
    expect((await upload(t.env, 'cyber', key('autre', '1a2b3c4d'))).status).toBe(400);
    expect((await upload(t.env, 'cyber', 'tts/openai/x.mp3')).status).toBe(400);
    expect(t.audio.objects.size).toBe(0);
  });

  it('refuse une clé déjà possédée par un autre contenu (403)', async () => {
    const t = createEnv();
    // « a-b-… » peut être revendiquée par « a » comme par « a-b »
    await upload(t.env, 'a-b', 'prepared-content/a-b-faithful-1a2b3c4d.mp3');
    expect((await upload(t.env, 'a', 'prepared-content/a-b-faithful-1a2b3c4d.mp3')).status).toBe(403);
  });

  it('sans contentId : comportement historique, aucune référence', async () => {
    const t = createEnv();
    const response = await call(t.env, '/content/audio?key=prepared-content/x.mp3', { method: 'POST', body: MP3 });
    expect(response.status).toBe(200);
    expect(await refs(t, 'prepared-content/x.mp3')).toEqual([]);
  });
});

describe('publication', () => {
  it('POST /content active la clé', async () => {
    const t = createEnv();
    await upload(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    expect((await refs(t, key('cyber', '1a2b3c4d')))[0].state).toBe('active');
  });

  it('EA-06 : republier avec un nouvel audio retire l’ancien, qui reste lisible', async () => {
    const t = createEnv();
    const ancien = key('cyber', '1a2b3c4d');
    const nouveau = key('cyber', '9f8e7d6c');
    await upload(t.env, 'cyber', ancien);
    await publish(t.env, 'cyber', ancien);
    await upload(t.env, 'cyber', nouveau);
    await publish(t.env, 'cyber', nouveau);
    expect((await refs(t, ancien))[0].state).toBe('retired');
    expect((await refs(t, nouveau))[0].state).toBe('active');
    expect((await call(t.env, `/audio/${ancien}`, { auth: false })).status).toBe(200);
    const detail = await (await call(t.env, '/content/cyber')).json() as { audioR2Key: string };
    expect(detail.audioR2Key).toBe(nouveau);
  });

  it('republier la même clé ne la retire pas', async () => {
    const t = createEnv();
    await upload(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    expect(await refs(t, key('cyber', '1a2b3c4d'))).toHaveLength(1);
    expect((await refs(t, key('cyber', '1a2b3c4d')))[0].state).toBe('active');
  });

  it('un contenu texte sans audio retire l’audio précédent', async () => {
    const t = createEnv();
    await upload(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', null);
    expect((await refs(t, key('cyber', '1a2b3c4d')))[0].state).toBe('retired');
  });

  it('refuse de pointer vers l’audio d’un autre contenu (403), sans rien écrire', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    const response = await call(t.env, '/content', { method: 'POST', body: payload('b', key('a', '1a2b3c4d')) });
    expect(response.status).toBe(403);
    expect((await call(t.env, '/content/b')).status).toBe(404);
  });

  it('ancien atelier (clé fixe, sans contentId) : la clé est quand même référencée à la publication', async () => {
    const t = createEnv();
    await call(t.env, '/content/audio?key=prepared-content/old.mp3', { method: 'POST', body: MP3 });
    await publish(t.env, 'old', 'prepared-content/old.mp3');
    expect((await refs(t, 'prepared-content/old.mp3'))[0].state).toBe('active');
  });

  it('PATCH audioR2Key suit le même cycle de vie', async () => {
    const t = createEnv();
    await upload(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await publish(t.env, 'cyber', key('cyber', '1a2b3c4d'));
    await upload(t.env, 'cyber', key('cyber', '9f8e7d6c'));
    expect((await call(t.env, '/content/cyber', { method: 'PATCH', body: { audioR2Key: key('cyber', '9f8e7d6c') } })).status).toBe(200);
    expect((await refs(t, key('cyber', '1a2b3c4d')))[0].state).toBe('retired');
    expect((await refs(t, key('cyber', '9f8e7d6c')))[0].state).toBe('active');
  });

  it('l’éviction du 51e contenu retire l’audio du plus ancien sans le supprimer', async () => {
    const t = createEnv();
    await upload(t.env, 'c00', key('c00', '1a2b3c4d'));
    await publish(t.env, 'c00', key('c00', '1a2b3c4d'));
    t.db.sqlite.exec("UPDATE content SET created_at = '2020-01-01 00:00:00'");
    for (let i = 1; i < 50; i += 1) await publish(t.env, `c${String(i).padStart(2, '0')}`, null);
    await publish(t.env, 'nouveau', null);
    expect((await call(t.env, '/content/c00')).status).toBe(404);
    expect((await refs(t, key('c00', '1a2b3c4d')))[0].state).toBe('retired');
    expect(t.audio.objects.has(key('c00', '1a2b3c4d'))).toBe(true);
  });
});

describe('POST /content/audio/retire', () => {
  async function setup() {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    await upload(t.env, 'a', key('a', '9f8e7d6c')); // pending, jamais publié
    await upload(t.env, 'b', key('b', '1a2b3c4d'));
    await publish(t.env, 'b', key('b', '1a2b3c4d'));
    return t;
  }
  const retire = (env: Env['env'], body: unknown, auth = true) => call(env, '/content/audio/retire', { method: 'POST', body, auth });

  it('retire une clé non active du contenu', async () => {
    const t = await setup();
    expect((await retire(t.env, { contentId: 'a', key: key('a', '9f8e7d6c') })).status).toBe(200);
    expect((await refs(t, key('a', '9f8e7d6c')))[0].state).toBe('retired');
  });

  it('EA-19 : 403 pour la clé d’un autre contenu, aucune référence modifiée', async () => {
    const t = await setup();
    expect((await retire(t.env, { contentId: 'a', key: key('b', '1a2b3c4d') })).status).toBe(403);
    expect((await refs(t, key('b', '1a2b3c4d')))[0].state).toBe('active');
  });

  it('409 pour la clé active du contenu', async () => {
    const t = await setup();
    expect((await retire(t.env, { contentId: 'a', key: key('a', '1a2b3c4d') })).status).toBe(409);
    expect((await refs(t, key('a', '1a2b3c4d')))[0].state).toBe('active');
  });

  it('400 hors prepared-content/, 404 pour une clé inconnue, 401 sans secret', async () => {
    const t = await setup();
    expect((await retire(t.env, { contentId: 'a', key: 'tts/openai/x.mp3' })).status).toBe(400);
    expect((await retire(t.env, { contentId: 'a', key: key('a', '00000000') })).status).toBe(404);
    expect((await retire(t.env, { contentId: 'a', key: key('a', '9f8e7d6c') }, false)).status).toBe(401);
  });
});

describe('nettoyage de nuit', () => {
  it('EA-20 : un upload jamais publié disparaît après 24 h, pas avant', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([]);
    age(t, DAY - 3600 * 1000);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([]);
    age(t, DAY + 60 * 1000);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([key('a', '1a2b3c4d')]);
    expect(t.audio.objects.has(key('a', '1a2b3c4d'))).toBe(false);
    expect(await refs(t, key('a', '1a2b3c4d'))).toEqual([]);
  });

  it('une clé retirée part après 7 jours, jamais la clé active', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    await upload(t.env, 'a', key('a', '9f8e7d6c'));
    await publish(t.env, 'a', key('a', '9f8e7d6c'));
    age(t, 6 * DAY);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([]);
    age(t, 8 * DAY);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([key('a', '1a2b3c4d')]);
    expect(t.audio.objects.has(key('a', '9f8e7d6c'))).toBe(true);
  });

  it('EA-07 : contenu supprimé, mais une carte SRS utilise l’audio → conservé', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    // La création de cartes depuis l'écoute active arrive au LOT 3 : on
    // insère la référence comme le fera POST /listening/promote-chunks.
    t.db.sqlite.prepare("INSERT INTO audio_references (key, content_id, kind, ref_id, state) VALUES (?, 'a', 'srs_card', 'default_w1', 'active')")
      .run(key('a', '1a2b3c4d'));
    await call(t.env, '/content/a', { method: 'DELETE' });
    age(t, 30 * DAY);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([]);
    expect((await call(t.env, `/audio/${key('a', '1a2b3c4d')}`, { auth: false })).status).toBe(200);
  });

  it('EA-21 : une fois la référence de carte supprimée, le fichier part au nettoyage', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    t.db.sqlite.prepare("INSERT INTO audio_references (key, content_id, kind, ref_id, state) VALUES (?, 'a', 'srs_card', 'default_w1', 'active')")
      .run(key('a', '1a2b3c4d'));
    await call(t.env, '/content/a', { method: 'DELETE' });
    t.db.sqlite.exec("DELETE FROM audio_references WHERE kind = 'srs_card'");
    age(t, 8 * DAY);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([key('a', '1a2b3c4d')]);
  });

  it('ne touche jamais une clé encore servie par un contenu, ni hors prepared-content/', async () => {
    const t = createEnv();
    await upload(t.env, 'a', key('a', '1a2b3c4d'));
    await publish(t.env, 'a', key('a', '1a2b3c4d'));
    // Incohérence simulée : référence retirée alors que le contenu sert la clé
    t.db.sqlite.exec("UPDATE audio_references SET state = 'retired', retired_at = '2000-01-01 00:00:00'");
    t.db.sqlite.prepare("INSERT INTO audio_references (key, content_id, kind, ref_id, state, retired_at) VALUES ('tts/openai/x.mp3', 'a', 'content', 'z', 'retired', '2000-01-01 00:00:00')").run();
    age(t, 30 * DAY);
    expect((await cleanupAudioReferences(t.env)).deleted).toEqual([]);
  });
});

describe('migration 0015 : reprise de l’existant', () => {
  it('crée une référence active pour chaque audio de l’atelier déjà publié', () => {
    const dir = join(__dirname, '..', 'migrations');
    const sqlite = new DatabaseSync(':memory:');
    for (const file of ['0001_schema.sql', '0002_cloud_schema.sql']) sqlite.exec(readFileSync(join(dir, file), 'utf8'));
    sqlite.exec(`INSERT INTO content (id, profile_id, type, body, metadata, audio_r2_key) VALUES
      ('can', 'default', 'podcast', '', '{}', 'prepared-content/can.mp3'),
      ('blk', 'default', 'podcast', '', '{}', 'prepared-content/blk-en.mp3'),
      ('tts', 'default', 'story', '', '{}', 'tts/openai/x.mp3'),
      ('txt', 'default', 'story', '', '{}', NULL)`);
    sqlite.exec(readFileSync(join(dir, '0015_audio_references.sql'), 'utf8'));
    const rows = sqlite.prepare('SELECT key, content_id, kind, ref_id, state FROM audio_references ORDER BY key').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { key: 'prepared-content/blk-en.mp3', content_id: 'blk', kind: 'content', ref_id: 'blk', state: 'active' },
      { key: 'prepared-content/can.mp3', content_id: 'can', kind: 'content', ref_id: 'can', state: 'active' },
    ]);
  });
});

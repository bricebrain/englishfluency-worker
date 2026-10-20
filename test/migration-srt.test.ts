/** Migration locale réelle sur SQLite peuplé, sans accès réseau ni fournisseur IA. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const directory = join(__dirname, '..', 'migrations');
const migrationName = '0021_remove_srt_library.sql';
const migration = readFileSync(join(directory, migrationName), 'utf8');

function beforeRemoval() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < migrationName).sort()) {
    db.exec(readFileSync(join(directory, name), 'utf8'));
  }
  return db;
}

function srtTables(db: DatabaseSync) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'srt_*' ORDER BY name").all();
}

function retainedCounts(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'srt_*' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
  return tables.map(({ name }) => [name, db.prepare(`SELECT count(*) AS count FROM "${String(name).replaceAll('"', '""')}"`).get()?.count]);
}

describe('0021 — suppression de la bibliothèque SRT', () => {
  it('retire les quatre tables peuplées et préserve les données hors SRT, y compris les marqueurs de purge', () => {
    const db = beforeRemoval();
    try {
      expect(srtTables(db)).toHaveLength(4);
      db.exec(`
        INSERT INTO srt_sources (id, title, r2_prefix) VALUES ('source', 'Série', 'private/series/');
        INSERT INTO srt_episodes (id, source_id, episode_no, title, r2_key)
          VALUES ('episode', 'source', 1, 'Épisode', 'private/series/1.srt');
        INSERT INTO srt_scenes (id, episode_id, scene_index, start_ms, end_ms, start_time, end_time, text)
          VALUES ('scene', 'episode', 0, 0, 1000, '00:00:00', '00:00:01', 'Hello.');
        INSERT INTO srt_scene_questions (scene_id, questions_json, model) VALUES ('scene', '[]', 'test');
        INSERT INTO semantic_index (vector_id, source, ref_id, parent_id, text_hash)
          VALUES ('legacy-vector', 'srt', 'scene', 'episode', 'hash');
      `);
      const retained = retainedCounts(db);
      db.exec(migration);
      expect(srtTables(db)).toEqual([]);
      expect(retainedCounts(db)).toEqual(retained);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare("SELECT source, ref_id FROM semantic_index WHERE vector_id = 'legacy-vector'").get())
        .toMatchObject({ source: 'srt', ref_id: 'scene' });
    } finally {
      db.close();
    }
  });

  it('peut être rejouée quand les tables sont déjà absentes', () => {
    const db = beforeRemoval();
    try {
      db.exec(migration);
      const retained = retainedCounts(db);
      expect(() => db.exec(migration)).not.toThrow();
      expect(srtTables(db)).toEqual([]);
      expect(retainedCounts(db)).toEqual(retained);
    } finally {
      db.close();
    }
  });
});

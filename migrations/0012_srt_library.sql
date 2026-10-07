-- Migration 0012 : bibliothèque personnelle de sous-titres SRT.
-- Source: fichiers .srt privés dans R2 -> scènes textuelles exploitables dans l'app.

CREATE TABLE IF NOT EXISTS srt_sources (
  id          TEXT PRIMARY KEY NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'series',
  r2_prefix   TEXT NOT NULL,
  season_label TEXT,
  language    TEXT NOT NULL DEFAULT 'en',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS srt_episodes (
  id           TEXT PRIMARY KEY NOT NULL,
  source_id    TEXT NOT NULL,
  episode_no   INTEGER NOT NULL,
  title        TEXT NOT NULL,
  r2_key       TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'parsed'
               CHECK (status IN ('parsed', 'enriching', 'ready', 'failed')),
  line_count   INTEGER NOT NULL DEFAULT 0,
  scene_count  INTEGER NOT NULL DEFAULT 0,
  duration_sec INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES srt_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS srt_scenes (
  id              TEXT PRIMARY KEY NOT NULL,
  episode_id      TEXT NOT NULL,
  scene_index     INTEGER NOT NULL,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  text            TEXT NOT NULL,
  line_count      INTEGER NOT NULL DEFAULT 0,
  word_count      INTEGER NOT NULL DEFAULT 0,
  words_per_min   INTEGER NOT NULL DEFAULT 0,
  level           TEXT NOT NULL DEFAULT 'B1',
  difficulty_score INTEGER NOT NULL DEFAULT 50,
  shadowing_score INTEGER NOT NULL DEFAULT 50,
  status          TEXT NOT NULL DEFAULT 'parsed'
                  CHECK (status IN ('parsed', 'enriching', 'ready', 'failed')),
  shadowing_json  TEXT NOT NULL DEFAULT '[]',
  vocabulary_json TEXT NOT NULL DEFAULT '[]',
  questions_json  TEXT NOT NULL DEFAULT '[]',
  summary_fr      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (episode_id) REFERENCES srt_episodes(id) ON DELETE CASCADE,
  UNIQUE (episode_id, scene_index)
);

CREATE INDEX IF NOT EXISTS idx_srt_episodes_source
  ON srt_episodes(source_id, episode_no);

CREATE INDEX IF NOT EXISTS idx_srt_scenes_episode
  ON srt_scenes(episode_id, scene_index);

CREATE INDEX IF NOT EXISTS idx_srt_scenes_level_shadowing
  ON srt_scenes(level, shadowing_score DESC);

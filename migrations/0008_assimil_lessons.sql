-- Migration 0008 : artefacts pédagogiques Assimil générés progressivement
-- Audio brut dans R2, transcript + exercices/notes dans D1.

CREATE TABLE IF NOT EXISTS assimil_lessons (
  lesson_index       INTEGER PRIMARY KEY NOT NULL,
  audio_key          TEXT NOT NULL,
  level              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'audio_ready',
  title_en           TEXT,
  title_fr           TEXT,
  transcript         TEXT,
  transcript_source  TEXT,
  lesson_json        TEXT NOT NULL DEFAULT '{}',
  generated_by       TEXT,
  generation_version INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assimil_lessons_level
  ON assimil_lessons(level, lesson_index);

CREATE INDEX IF NOT EXISTS idx_assimil_lessons_status
  ON assimil_lessons(status, updated_at DESC);

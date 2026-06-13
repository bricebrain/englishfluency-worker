-- Migration 0005 : mémoire pédagogique unifiée
-- Journal des événements d'apprentissage + base de recommandation quotidienne

CREATE TABLE IF NOT EXISTS learning_events (
  id           TEXT PRIMARY KEY NOT NULL,
  profile_id   TEXT NOT NULL,
  module       TEXT NOT NULL,      -- review | lingvist | speak | read | listen | course
  event_type   TEXT NOT NULL,      -- review_word | article_completed | podcast_completed | speak_completed ...
  skill        TEXT NOT NULL,      -- vocabulary | speaking | reading | listening | grammar
  content_id   TEXT,
  score        REAL,
  duration_sec INTEGER,
  payload      TEXT NOT NULL DEFAULT '{}',
  occurred_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_events_profile_time
  ON learning_events(profile_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_profile_module
  ON learning_events(profile_id, module, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_profile_skill
  ON learning_events(profile_id, skill, occurred_at DESC);

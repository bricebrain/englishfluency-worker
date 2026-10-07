-- Migration 0010 : Podcast feeds → transcripts Deepgram → reading lessons.
-- Source: RSS podcasts anglais (conversations authentiques + news).
-- Réutilise transcribeWithDeepgram() de assimilDeepgram.ts (Nova-3 + diarisation).
-- Voir PODCAST_FEEDS_SPEC.md pour le contrat API complet.

-- ── Feeds RSS configurés ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS podcast_feeds (
  id               TEXT PRIMARY KEY NOT NULL,
  title            TEXT NOT NULL,
  rss_url          TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('conversation', 'news', 'tech')),
  language         TEXT NOT NULL DEFAULT 'en',
  cefr_level_hint  TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  image_url        TEXT,
  last_fetched_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Épisodes scannés + transcrits + lessons générées ────────────────────────
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id                    TEXT PRIMARY KEY NOT NULL,
  feed_id               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT,
  audio_url             TEXT NOT NULL,
  duration_sec          INTEGER,
  published_at          TEXT,
  image_url             TEXT,
  transcription_status  TEXT NOT NULL DEFAULT 'pending'
                        CHECK (transcription_status IN ('pending', 'transcribing', 'ready', 'failed')),
  transcription_provider TEXT,
  transcript_text       TEXT,
  dialogue_json         TEXT,
  lesson_status         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (lesson_status IN ('pending', 'generating', 'ready', 'failed')),
  lesson_json           TEXT,
  audio_key             TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (feed_id) REFERENCES podcast_feeds(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_feed_date
  ON podcast_episodes(feed_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_transcription
  ON podcast_episodes(transcription_status)
  WHERE transcription_status != 'ready';

CREATE INDEX IF NOT EXISTS idx_podcast_episodes_lesson
  ON podcast_episodes(lesson_status)
  WHERE lesson_status != 'ready';

-- Seed initial : les 2 feeds conversation prioritaires
INSERT OR IGNORE INTO podcast_feeds (id, title, rss_url, kind, cefr_level_hint) VALUES
  ('bbc-6min', '6 Minute English', 'https://podcasts.files.bbci.co.uk/p02pc9zn.rss', 'conversation', 'B1-B2'),
  ('leonardo-english', 'Leonardo English', 'https://feeds.transistor.fm/leonardo-english-english-language-learning-for-curious-minds', 'conversation', 'B2-C1');

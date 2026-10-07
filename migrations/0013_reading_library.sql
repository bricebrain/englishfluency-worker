-- Migration 0013 : bibliothèque Lire guidée.
-- Sources premium (VOA/BBC/etc.) -> articles préparés -> segments pédagogiques.

CREATE TABLE IF NOT EXISTS reading_library_sources (
  id              TEXT PRIMARY KEY NOT NULL,
  title           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'rss',
  category        TEXT NOT NULL DEFAULT 'general',
  url             TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  cefr_hint       TEXT,
  last_fetched_at TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reading_library_items (
  id              TEXT PRIMARY KEY NOT NULL,
  source_id       TEXT NOT NULL,
  title           TEXT NOT NULL,
  url             TEXT NOT NULL,
  published_at    TEXT,
  description     TEXT,
  raw_text        TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'B1',
  category        TEXT NOT NULL DEFAULT 'general',
  status          TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  word_count      INTEGER NOT NULL DEFAULT 0,
  segment_count   INTEGER NOT NULL DEFAULT 0,
  summary_fr      TEXT,
  audio_url       TEXT,
  image_url       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES reading_library_sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reading_library_segments (
  id              TEXT PRIMARY KEY NOT NULL,
  item_id         TEXT NOT NULL,
  segment_index   INTEGER NOT NULL,
  title           TEXT NOT NULL,
  text            TEXT NOT NULL,
  summary_fr      TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'B1',
  word_count      INTEGER NOT NULL DEFAULT 0,
  vocabulary_json TEXT NOT NULL DEFAULT '[]',
  questions_json  TEXT NOT NULL DEFAULT '[]',
  shadowing_json  TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (item_id) REFERENCES reading_library_items(id) ON DELETE CASCADE,
  UNIQUE (item_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_reading_library_items_source
  ON reading_library_items(source_id, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_reading_library_items_status
  ON reading_library_items(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_reading_library_segments_item
  ON reading_library_segments(item_id, segment_index);

INSERT OR IGNORE INTO reading_library_sources (
  id, title, provider, kind, category, url, cefr_hint
) VALUES
  (
    'bbc-6-minute-english',
    'BBC Learning English · 6 Minute English',
    'BBC Learning English',
    'rss',
    'general',
    'https://podcasts.files.bbci.co.uk/p02pc9tn.rss',
    'B1'
  ),
  (
    'thinking-in-english',
    'Thinking in English',
    'Thinking in English',
    'rss',
    'culture',
    'https://thinkinginenglish.blog/feed/',
    'B2'
  ),
  (
    'the-conversation-tech',
    'The Conversation · Science + Tech',
    'The Conversation',
    'atom',
    'tech',
    'https://theconversation.com/us/technology/articles.atom',
    'B2'
  ),
  (
    'the-conversation-business',
    'The Conversation · Business + Economy',
    'The Conversation',
    'atom',
    'business',
    'https://theconversation.com/us/business/articles.atom',
    'B2'
  ),
  (
    'sciencedaily-top',
    'ScienceDaily · Top Science',
    'ScienceDaily',
    'rss',
    'science',
    'https://www.sciencedaily.com/rss/top/science.xml',
    'B2'
  );

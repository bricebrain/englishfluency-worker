-- Migration 0004 : chaînes YouTube pour les leçons pédagogiques

CREATE TABLE IF NOT EXISTS youtube_channels (
  id         TEXT PRIMARY KEY NOT NULL,   -- YouTube channel ID (ex: UCHaHD477h-FeBbVh9Sh7syA)
  name       TEXT NOT NULL,               -- Nom affiché (ex: BBC Learning English)
  active     INTEGER NOT NULL DEFAULT 1, -- 1 = actif, 0 = désactivé
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed : chaînes initiales
INSERT OR IGNORE INTO youtube_channels (id, name) VALUES
  ('UCHaHD477h-FeBbVh9Sh7syA', 'BBC Learning English'),
  ('UCKRBA9XfgzAtJodE4t8cUeg', 'engVid');

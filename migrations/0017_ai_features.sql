-- Fonctions IA (Workers AI) : recherche par le sens, contenus générés,
-- tâches nocturnes et analyse des bilans Live.

-- Passages déjà indexés dans Vectorize (un vecteur par passage).
CREATE TABLE IF NOT EXISTS semantic_index (
  vector_id   TEXT PRIMARY KEY NOT NULL,
  source      TEXT NOT NULL,           -- content | reading | srt
  ref_id      TEXT NOT NULL,           -- segment / scène / passage
  parent_id   TEXT,                    -- contenu, article ou épisode
  text_hash   TEXT NOT NULL,
  indexed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_semantic_index_source ON semantic_index(source, ref_id);

-- Exercices et histoire du jour générés pour un profil.
CREATE TABLE IF NOT EXISTS generated_exercises (
  profile_id  TEXT NOT NULL,
  day         TEXT NOT NULL,           -- YYYY-MM-DD
  kind        TEXT NOT NULL,           -- sentences | story
  payload     TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (profile_id, day, kind)
);

-- Questions de compréhension générées pour les scènes SRT.
CREATE TABLE IF NOT EXISTS srt_scene_questions (
  scene_id       TEXT PRIMARY KEY NOT NULL,
  questions_json TEXT NOT NULL,
  model          TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (scene_id) REFERENCES srt_scenes(id) ON DELETE CASCADE
);

-- Brouillons d'enrichissement proposés la nuit à l'atelier Vocabulaire
-- (jamais publiés automatiquement : l'atelier valide puis publie un lot).
CREATE TABLE IF NOT EXISTS vocabulary_enrichment_drafts (
  word_id     TEXT PRIMARY KEY NOT NULL,
  data        TEXT NOT NULL,
  model       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | used | rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);

-- Consommation estimée de neurones Workers AI par jour (UTC).
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day         TEXT PRIMARY KEY NOT NULL,
  neurons     REAL NOT NULL DEFAULT 0,
  calls       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bilans de séance Live et leur analyse.
CREATE TABLE IF NOT EXISTS live_report_analyses (
  id            TEXT PRIMARY KEY NOT NULL,
  profile_id    TEXT NOT NULL,
  report        TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_live_report_analyses_profile ON live_report_analyses(profile_id, created_at DESC);

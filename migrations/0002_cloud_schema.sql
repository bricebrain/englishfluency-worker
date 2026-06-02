-- Migration 0002 : schéma cloud complet
-- Profils, SRS, contenu, dictée, lingvist

-- ── Profils utilisateurs ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'B1',
  daily_goal INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── SRS : progression par mot par profil ────────────────────────────────────
CREATE TABLE IF NOT EXISTS word_progress (
  id                 TEXT PRIMARY KEY NOT NULL, -- {profile_id}_{word_id}
  profile_id         TEXT NOT NULL,
  word_id            TEXT NOT NULL,
  prochaine_revision TEXT NOT NULL,
  intervalle         INTEGER NOT NULL DEFAULT 0,
  facilite           REAL    NOT NULL DEFAULT 2.5,
  repetitions        INTEGER NOT NULL DEFAULT 0,
  derniere_revision  TEXT,
  seen_count         INTEGER NOT NULL DEFAULT 0,
  success_count      INTEGER NOT NULL DEFAULT 0,
  almost_count       INTEGER NOT NULL DEFAULT 0,
  fail_count         INTEGER NOT NULL DEFAULT 0,
  level              REAL    NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'new',
  review_history     TEXT    NOT NULL DEFAULT '[]',
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wp_profile       ON word_progress(profile_id);
CREATE INDEX IF NOT EXISTS idx_wp_profile_word  ON word_progress(profile_id, word_id);
CREATE INDEX IF NOT EXISTS idx_wp_next_review   ON word_progress(profile_id, prochaine_revision);

-- ── SRS : historique quotidien de révision ──────────────────────────────────
CREATE TABLE IF NOT EXISTS review_history_daily (
  id         TEXT PRIMARY KEY NOT NULL, -- {profile_id}_{day}
  profile_id TEXT NOT NULL,
  day        TEXT NOT NULL, -- YYYY-MM-DD
  count      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rhd_profile ON review_history_daily(profile_id);

-- ── Contenu généré par IA (histoires, grammaire, traductions, podcasts, cours)
CREATE TABLE IF NOT EXISTS content (
  id          TEXT PRIMARY KEY NOT NULL,
  profile_id  TEXT NOT NULL,
  type        TEXT NOT NULL, -- story | grammar_note | translation | podcast | course
  title       TEXT,
  level       TEXT,
  topic       TEXT,
  body        TEXT NOT NULL DEFAULT '',  -- markdown ou JSON
  metadata    TEXT NOT NULL DEFAULT '{}', -- JSON (voix, durée, segments…)
  audio_r2_key TEXT,                     -- clé R2 si audio pré-généré
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_profile      ON content(profile_id);
CREATE INDEX IF NOT EXISTS idx_content_profile_type ON content(profile_id, type);
CREATE INDEX IF NOT EXISTS idx_content_created      ON content(created_at DESC);

-- ── Sessions de dictée ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dictation_sessions (
  id                TEXT PRIMARY KEY NOT NULL,
  profile_id        TEXT NOT NULL,
  level             TEXT NOT NULL,
  sentence          TEXT NOT NULL,
  user_input        TEXT,
  score             INTEGER NOT NULL DEFAULT 0,
  item_count        INTEGER NOT NULL DEFAULT 0,
  correct_count     INTEGER NOT NULL DEFAULT 0,
  minor_count       INTEGER NOT NULL DEFAULT 0,
  incorrect_count   INTEGER NOT NULL DEFAULT 0,
  errors            TEXT NOT NULL DEFAULT '[]',
  global_feedback_fr TEXT NOT NULL DEFAULT '',
  generation_source TEXT,
  correction_source TEXT NOT NULL DEFAULT 'remote',
  audio_r2_key      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dictation_profile ON dictation_sessions(profile_id);
CREATE INDEX IF NOT EXISTS idx_dictation_created ON dictation_sessions(created_at DESC);

-- ── Cartes Lingvist (phrase à trou) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lingvist_cards (
  id               TEXT PRIMARY KEY NOT NULL, -- {profile_id}_{word_id}
  profile_id       TEXT NOT NULL,
  word_id          TEXT NOT NULL,
  example_en       TEXT NOT NULL,
  lemma            TEXT NOT NULL,
  target_pos       TEXT NOT NULL DEFAULT 'other',
  verb_form_label  TEXT,
  expected_answer  TEXT NOT NULL,
  sentence_with_gap TEXT NOT NULL,
  sentence_full    TEXT NOT NULL,
  translation_fr   TEXT NOT NULL,
  grammar_hint     TEXT NOT NULL,
  input_placeholder TEXT NOT NULL,
  source           TEXT NOT NULL DEFAULT 'remote',
  schema_version   INTEGER NOT NULL DEFAULT 4,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lingvist_profile ON lingvist_cards(profile_id);

-- ── Calibration Lingvist ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lingvist_calibration (
  profile_id TEXT PRIMARY KEY NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

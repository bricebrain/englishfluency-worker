-- Migration 0001 : schéma initial englishfluency
-- Table principale du vocabulaire

CREATE TABLE IF NOT EXISTS words (
  id              TEXT PRIMARY KEY NOT NULL,
  mot             TEXT NOT NULL,
  type            TEXT NOT NULL,
  niveau          TEXT NOT NULL,           -- A1 A2 B1 B2 C1 C2
  traduction      TEXT,
  ipa_uk          TEXT,
  ipa_us          TEXT,
  audio_uk        TEXT NOT NULL DEFAULT '',
  audio_us        TEXT NOT NULL DEFAULT '',
  registre        TEXT NOT NULL DEFAULT 'neutral',
  faux_ami        INTEGER NOT NULL DEFAULT 0,   -- 0 | 1
  faux_ami_note   TEXT,
  frequence       INTEGER NOT NULL DEFAULT 3,   -- 1-5
  examples        TEXT NOT NULL DEFAULT '[]',   -- JSON [{en,fr}]
  synonymes       TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  collocations    TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  famille_de_mots TEXT NOT NULL DEFAULT '{}',   -- JSON {noun,verb,adj,adv}
  tags            TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index pour les requêtes fréquentes de l'app
CREATE INDEX IF NOT EXISTS idx_words_niveau    ON words(niveau);
CREATE INDEX IF NOT EXISTS idx_words_frequence ON words(frequence DESC);
CREATE INDEX IF NOT EXISTS idx_words_registre  ON words(registre);
CREATE INDEX IF NOT EXISTS idx_words_faux_ami  ON words(faux_ami) WHERE faux_ami = 1;
CREATE INDEX IF NOT EXISTS idx_words_updated   ON words(updated_at);

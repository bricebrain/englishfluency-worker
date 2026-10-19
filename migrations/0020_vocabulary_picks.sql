-- Canonicalisation dédiée aux imports : préserve les homonymes du référentiel existant.
CREATE TABLE vocabulary_pick_words (
  normalized_word TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE
);
INSERT INTO vocabulary_pick_words SELECT lower(trim(mot)),min(id) FROM words GROUP BY lower(trim(mot));
CREATE TABLE vocabulary_pick_receipts (
  profile_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('sent','already_known')),
  context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id,source_id)
);

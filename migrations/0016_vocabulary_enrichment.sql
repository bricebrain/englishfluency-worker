CREATE TABLE IF NOT EXISTS vocabulary_enrichments (
  word_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  data TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vocabulary_enrichment_versions (
  word_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  data TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY (word_id, version),
  FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vocabulary_enrichment_batches (
  batch_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  entry_ids TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_enrichment_batches_status
  ON vocabulary_enrichment_batches(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_enrichment_versions_published
  ON vocabulary_enrichment_versions(word_id, published_at DESC);

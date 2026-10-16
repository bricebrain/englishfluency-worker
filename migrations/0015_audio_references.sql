-- Migration 0015 : références actives des audios R2 (LOT 1, écoute active v1.2 § 8.2).
-- Un fichier `prepared-content/…` n'est supprimé de R2 que lorsqu'aucune
-- référence ne le vise plus, après un délai : 24 h pour un upload jamais
-- activé (`pending`), 7 jours pour une clé `retired`. Les références
-- `srs_card` et `transfer` bloquent toute suppression.

CREATE TABLE IF NOT EXISTS audio_references (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  content_id  TEXT NOT NULL,                -- contenu propriétaire de la clé
  kind        TEXT NOT NULL CHECK (kind IN ('content', 'srs_card', 'transfer')),
  ref_id      TEXT NOT NULL,                -- id du contenu, de la carte ou du transfert
  state       TEXT NOT NULL CHECK (state IN ('pending', 'active', 'retired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audio_references_ref     ON audio_references(key, kind, ref_id);
CREATE INDEX        IF NOT EXISTS idx_audio_references_content ON audio_references(content_id);
CREATE INDEX        IF NOT EXISTS idx_audio_references_state   ON audio_references(state);

-- Reprise de l'existant : chaque audio de l'atelier déjà publié devient une
-- référence active de son contenu.
INSERT OR IGNORE INTO audio_references (key, content_id, kind, ref_id, state)
SELECT audio_r2_key, id, 'content', id, 'active'
FROM content
WHERE audio_r2_key LIKE 'prepared-content/%';

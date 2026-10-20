-- Retrait de la bibliothèque de séries/SRT et de ses questions générées.
-- Les entrées Vectorize associées sont purgées par l'indexeur sémantique,
-- qui conserve leurs identifiants dans semantic_index jusqu'à son prochain passage.

DROP TABLE IF EXISTS srt_scene_questions;
DROP TABLE IF EXISTS srt_scenes;
DROP TABLE IF EXISTS srt_episodes;
DROP TABLE IF EXISTS srt_sources;

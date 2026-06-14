-- Migration 0009 : jobs RunPod et analyse audio Assimil.
-- Permet de traiter les transcriptions longues en asynchrone et de conserver
-- les timestamps/segments audio pour la lecture phrase par phrase.

ALTER TABLE assimil_lessons ADD COLUMN transcription_job_id TEXT;
ALTER TABLE assimil_lessons ADD COLUMN transcription_status TEXT;
ALTER TABLE assimil_lessons ADD COLUMN audio_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_assimil_lessons_transcription_job
  ON assimil_lessons(transcription_job_id);

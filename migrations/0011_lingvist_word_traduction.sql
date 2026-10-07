-- 0011 — Ajoute la traduction FR du mot cible sur les cartes Lingvist.
-- Permet d'afficher "le mot à trouver en français" dans l'état Question.
-- Colonne nullable : les cartes existantes restent valides (fallback '' côté client).
ALTER TABLE lingvist_cards ADD COLUMN word_traduction_fr TEXT;

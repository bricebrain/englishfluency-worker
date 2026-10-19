-- Version de l’enrichissement lors de la préparation ; NULL pour les cartes historiques.
-- Aucune carte ni progression n’est supprimée ou reconstruite.
ALTER TABLE lingvist_cards ADD COLUMN enrichment_version INTEGER;

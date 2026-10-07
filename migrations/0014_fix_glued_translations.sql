-- Migration 0014 : traductions françaises collées dans le lexique d'origine
-- (« demanderà » au lieu de « demander à », etc.). Corrige aussi les cartes
-- Lingvist déjà préparées, qui avaient recopié la traduction fautive.

UPDATE words SET traduction = 'demander (à)' WHERE id = 'ask_0036';
UPDATE words SET traduction = 'donner, passer' WHERE id = 'give_0278';
UPDATE words SET traduction = 'dire (à)' WHERE id = 'tell_0637';
UPDATE words SET traduction = 'permettre (à … de faire)' WHERE id = 'allow_0765';
UPDATE words SET traduction = 'recommander' WHERE id = 'recommend_1257';
UPDATE words SET traduction = 'suggérer, conseiller' WHERE id = 'suggest_1360';
UPDATE words SET traduction = 'accrocher, suspendre' WHERE id = 'hang_1694';
UPDATE words SET traduction = 'rappeler (à)' WHERE id = 'remind_1899';
UPDATE words SET traduction = 'exposer (à)' WHERE id = 'expose_2228';
UPDATE words SET traduction = 'devoir (à)' WHERE id = 'owe_2377';
UPDATE words SET traduction = 'assurer' WHERE id = 'assure_2592';
UPDATE words SET traduction = 'consacrer (à)' WHERE id = 'devote_2708';
UPDATE words SET traduction = 'restreindre (à)' WHERE id = 'restrict_3059';
UPDATE words SET traduction = 'contraindre (à faire)' WHERE id = 'compel_3416';
UPDATE words SET traduction = 'disposer' WHERE id = 'dispose_3582';
UPDATE words SET traduction = 'donner le pouvoir d''agir à' WHERE id = 'empower_3624';
UPDATE words SET traduction = 'donner droit à' WHERE id = 'entitle_3644';
UPDATE words SET traduction = 'obliger, forcer (à faire)' WHERE id = 'oblige_3966';
UPDATE words SET traduction = 'rendre' WHERE id = 'give_back_4507';

-- Traductions vides ou tronquées
UPDATE words SET traduction = 'douze' WHERE id = 'twelve_0681';
UPDATE words SET traduction = 'auxiliaire du futur' WHERE id = 'will_0720';
UPDATE words SET traduction = 'peut-être, éventuellement' WHERE id = 'possibly_1838';
UPDATE words SET traduction = 'nourrir, donner à manger à' WHERE id = 'feed_0998';

UPDATE lingvist_cards
SET word_traduction_fr = (SELECT w.traduction FROM words w WHERE w.id = lingvist_cards.word_id)
WHERE word_id IN ('allow_0765', 'ask_0036', 'assure_2592', 'compel_3416', 'devote_2708', 'dispose_3582', 'empower_3624', 'entitle_3644', 'expose_2228', 'give_0278', 'give_back_4507', 'hang_1694', 'oblige_3966', 'owe_2377', 'recommend_1257', 'remind_1899', 'restrict_3059', 'suggest_1360', 'tell_0637');

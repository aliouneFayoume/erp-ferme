-- ==============================================================================
-- MIGRATION 13 — Vérification croisée montant/référence sur l'IPN PayDunya
-- (audit développement 2026-08-11, liste "Ensuite")
-- ==============================================================================
-- Avant cette migration, le traitement de l'IPN PayDunya (routes/finance.js) créditait le montant
-- renvoyé par confirmerFacture() sans jamais le comparer au montant réellement attendu, ni vérifier
-- la reference_interne — alors même que paydunya.js documentait déjà cette valeur comme "sert de
-- vérification croisée en plus du token lui-même", sans que le code ne le fasse. 100% additif :
-- colonne nullable, les paiements déjà en base (dont d'anciens EN_ATTENTE) restent traitables (la
-- vérification référence est simplement ignorée si reference_interne est NULL — seul le montant
-- est alors comparé).
-- ==============================================================================

ALTER TABLE paiements ADD COLUMN IF NOT EXISTS reference_interne VARCHAR(150);

-- ==============================================================================
-- MIGRATION 08 — Numéro de contact WhatsApp pour la facturation SaaS
-- ==============================================================================
-- 100% additif et rejouable : ajoute juste la colonne (NULL par défaut, aucune ferme n'a de contact
-- WhatsApp configuré tant qu'Alioune ne le renseigne pas manuellement dans la vue plateforme).
-- ==============================================================================

ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS telephone_contact VARCHAR(20);

-- ==============================================================================
-- MIGRATION 37 — Rappel J-3 de fin d'essai gratuit par WhatsApp (Easystart, phase 5)
-- ==============================================================================
-- Un seul rappel par ferme d'essai, trois jours avant la fin : « Votre essai se termine dans 3 jours — passez en Pro pour
-- garder vos lots illimités ». Deux colonnes sur l'abonnement SaaS :
--   * rappel_fin_essai_envoye_le : date d'envoi (jamais remise à NULL après un succès : un seul rappel, jamais deux) ;
--   * rappel_fin_essai_tentatives : échecs d'envoi, avec un plafond (le balayage suivant réessaie, sans jamais harceler).
-- Le rappel reste FERMÉ tant que RAPPEL_FIN_ESSAI_ACTIF n'est pas « true » et qu'aucun modèle Meta n'est approuvé.
--
-- 100% additif et rejouable : aucune ligne existante modifiée, aucune policy RLS à changer.
-- ==============================================================================

ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS rappel_fin_essai_envoye_le TIMESTAMP;
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS rappel_fin_essai_tentatives INT NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (nom) VALUES ('migration-37-rappel-fin-essai.sql')
ON CONFLICT (nom) DO NOTHING;

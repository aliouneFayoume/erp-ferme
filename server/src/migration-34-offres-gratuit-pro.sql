-- ==============================================================================
-- MIGRATION 34 — Offres Gratuit / Essai / Pro tout inclus (dossier Easystart, phase 2)
-- ==============================================================================
-- Jusqu'ici une ferme avait une liste de modules (modules_actifs) et un prix négocié (montant_mensuel). La nouvelle
-- offre publique est : Gratuit (1 lot en cours, 1 utilisateur, pas de relances WhatsApp automatiques), Pro tout inclus
-- (10 000 FCFA/mois), et un essai de 30 jours qui donne le Pro puis retombe sur Gratuit.
--
-- `plan` NULL = ferme « sur mesure » : comportement historique inchangé (modules + prix négocié). TOUTES les fermes
-- existantes restent donc exactement comme avant (Ganaar Boumak, Fish Feed, Ferme Massla…). Seules les fermes dont on
-- renseigne un plan changent de régime.
--   GRATUIT : Socle + Clients, Commandes (encaissements) et Finance ; 1 lot en cours, 1 utilisateur.
--   ESSAI   : tout inclus jusqu'à essai_fin_le ; ensuite traitée comme GRATUIT (calculé à chaque requête, aucune tâche
--             planifiée à faire tourner, aucune donnée supprimée).
--   PRO     : tout inclus, sans limite.
-- essai_debut_le / essai_fin_le : dates de l'essai. source_inscription : porte d'entrée (« essai » ou « demo »).
-- converti_pro_le : date du passage en Pro (mesure de la conversion).
--
-- 100% additif : cinq colonnes nullables, aucune ligne existante touchée, aucune policy RLS à modifier.
-- ==============================================================================

ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS plan VARCHAR(10) CHECK (plan IS NULL OR plan IN ('GRATUIT', 'ESSAI', 'PRO'));
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS essai_debut_le TIMESTAMP;
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS essai_fin_le TIMESTAMP;
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS source_inscription VARCHAR(10) CHECK (source_inscription IS NULL OR source_inscription IN ('essai', 'demo'));
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS converti_pro_le TIMESTAMP;

INSERT INTO schema_migrations (nom) VALUES ('migration-34-offres-gratuit-pro.sql')
ON CONFLICT (nom) DO NOTHING;

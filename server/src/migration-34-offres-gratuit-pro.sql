-- ==============================================================================
-- MIGRATION 34 — Offres : essai gratuit de 30 jours, puis Pro (dossier Easystart, phase 2)
-- ==============================================================================
-- Jusqu'ici une ferme avait une liste de modules (modules_actifs) et un prix négocié (montant_mensuel). La nouvelle
-- offre publique est : un essai gratuit de 30 jours (1 lot en cours, 1 utilisateur, pas de relances WhatsApp
-- automatiques), puis Pro à 10 000 FCFA/mois. La version complète reste réservée à la ferme Massla.
--
-- `plan` NULL = ferme « sur mesure » : comportement historique inchangé (modules + prix négocié). TOUTES les fermes
-- existantes restent donc exactement comme avant (Ganaar Boumak, Fish Feed, Ferme Massla…). Seules les fermes dont on
-- renseigne un plan changent de régime.
--   ESSAI : Socle + Clients, Commandes (encaissements) et Finance jusqu'à essai_fin_le ; 1 lot en cours, 1 utilisateur.
--           Ensuite : consultation seule (aucune saisie) jusqu'au passage en Pro, calculé à chaque requête — aucune tâche
--           planifiée à faire tourner, aucune donnée supprimée.
--   PRO   : mêmes modules, sans limite, avec relances WhatsApp automatiques et comptes pour l'équipe. Les modules « sur
--           demande » (élevage, paie…) s'ajoutent un par un dans modules_actifs.
-- essai_debut_le / essai_fin_le : dates de l'essai. source_inscription : porte d'entrée (« essai » ou « demo »).
-- converti_pro_le : date du passage en Pro (mesure de la conversion).
--
-- 100% additif : cinq colonnes nullables, aucune ligne existante touchée, aucune policy RLS à modifier.
-- ==============================================================================

ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS plan VARCHAR(10) CHECK (plan IS NULL OR plan IN ('ESSAI', 'PRO'));
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS essai_debut_le TIMESTAMP;
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS essai_fin_le TIMESTAMP;
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS source_inscription VARCHAR(10) CHECK (source_inscription IS NULL OR source_inscription IN ('essai', 'demo'));
ALTER TABLE organisation_abonnement_saas ADD COLUMN IF NOT EXISTS converti_pro_le TIMESTAMP;

INSERT INTO schema_migrations (nom) VALUES ('migration-34-offres-gratuit-pro.sql')
ON CONFLICT (nom) DO NOTHING;

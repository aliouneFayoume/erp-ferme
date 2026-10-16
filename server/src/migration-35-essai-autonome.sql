-- ==============================================================================
-- MIGRATION 35 — Essai autonome : inscription par téléphone + connexion par code WhatsApp (Easystart, phase 3)
-- ==============================================================================
-- L'essai gratuit de 30 jours s'ouvre sans e-mail ni mot de passe : la personne donne son numéro WhatsApp et le nom de sa
-- ferme, puis se reconnecte à chaque fois avec un code à 6 chiffres reçu sur WhatsApp (valable 10 minutes, 5 essais).
--
-- utilisateurs.email devient facultatif (un compte d'essai n'en a pas) ; une contrainte garantit qu'un compte garde au moins
-- un moyen de s'identifier (e-mail OU téléphone). utilisateurs.telephone est UNIQUE à l'échelle de la plateforme, comme
-- l'e-mail : à la connexion on ne connaît pas encore la ferme (même raison que clients.telephone, voir portail.js).
-- Les comptes existants gardent leur e-mail et leur mot de passe, rien ne change pour eux.
--
-- lots_production.est_demo : le lot de la « Ferme démo » (2 000 poulets, lot n°12) pré-rempli à l'ouverture d'un essai. Il est
-- créé TERMINÉ : il n'entre donc pas dans la limite « 1 lot en cours » de l'essai ni dans les statistiques des lots actifs, et
-- il se supprime en un clic (soft delete) sans toucher aux données réelles de la ferme.
--
-- 100% additif et rejouable : aucune ligne existante modifiée, aucune policy RLS à changer.
-- ==============================================================================

ALTER TABLE utilisateurs ALTER COLUMN email DROP NOT NULL;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS telephone VARCHAR(20);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS telephone_verifie BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS login_code_hash VARCHAR(64);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS login_code_expire_le TIMESTAMP;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS login_code_tentatives INT NOT NULL DEFAULT 0;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS login_code_envoye_le TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS uq_utilisateurs_telephone ON utilisateurs (telephone);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'utilisateurs_identifiant_chk') THEN
        ALTER TABLE utilisateurs ADD CONSTRAINT utilisateurs_identifiant_chk CHECK (email IS NOT NULL OR telephone IS NOT NULL);
    END IF;
END $$;

ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS est_demo BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations (nom) VALUES ('migration-35-essai-autonome.sql')
ON CONFLICT (nom) DO NOTHING;

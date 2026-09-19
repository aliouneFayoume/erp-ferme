-- ==============================================================================
-- MIGRATION 25 — Relance automatique des factures clients impayées (J+7)
-- ==============================================================================
-- 100% additif. Jusqu'ici, la relance WhatsApp d'une facture impayée n'existait qu'en manuel
-- (bouton "Rappel WhatsApp" de l'écran Finances). Un planificateur serveur (relancesAuto.js)
-- envoie désormais une relance 7 jours après la date d'échéance, une seule fois par facture.

-- rappel_auto_envoye_le : posé AVANT l'envoi (claim atomique -> jamais de doublon), remis à NULL
-- si l'envoi échoue. rappel_auto_tentatives : plafonne les échecs répétés (numéro invalide, jeton
-- expiré...). dernier_rappel_le : dernier rappel réussi, manuel OU automatique.
ALTER TABLE factures ADD COLUMN IF NOT EXISTS rappel_auto_envoye_le TIMESTAMP;
ALTER TABLE factures ADD COLUMN IF NOT EXISTS rappel_auto_tentatives INT NOT NULL DEFAULT 0;
ALTER TABLE factures ADD COLUMN IF NOT EXISTS dernier_rappel_le TIMESTAMP;

-- Interrupteur par ferme, activé par défaut (l'admin le coupe dans Réglages -> Relances WhatsApp).
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS relances_auto_actives BOOLEAN NOT NULL DEFAULT TRUE;

INSERT INTO schema_migrations (nom) VALUES ('migration-25-relances-auto.sql')
ON CONFLICT (nom) DO NOTHING;

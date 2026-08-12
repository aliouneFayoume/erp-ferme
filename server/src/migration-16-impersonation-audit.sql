-- ==============================================================================
-- MIGRATION 16 — Marqueur d'impersonation dans chaque écriture d'audit
-- (audit sécurité 2026-08-11, E4, 3e et dernier point)
-- ==============================================================================
-- Avant cette migration, seules les entrées CONNEXION_SUPPORT/FIN_SUPPORT montraient qu'une
-- session de support avait eu lieu — toute action faite PENDANT la session (modifier un client,
-- encaisser un paiement, changer un mot de passe...) était indiscernable d'une action normale de
-- l'admin de la ferme cible. logAudit() (audit.js) propage désormais automatiquement le marqueur
-- depuis le jeton en cours ; ces colonnes sont écrites par le code, jamais par un appelant.
-- 100% additif : colonnes nullable/à défaut, aucune ligne existante n'est affectée.
-- ==============================================================================

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS impersonation BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS superviseur_id INT REFERENCES utilisateurs(id);

INSERT INTO schema_migrations (nom) VALUES ('migration-16-impersonation-audit.sql')
ON CONFLICT (nom) DO NOTHING;

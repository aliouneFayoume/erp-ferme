-- ==============================================================================
-- MIGRATION 31 — Réinitialisation de mot de passe en libre-service (« Mot de passe oublié ? »)
-- ==============================================================================
-- Jusqu'ici, un utilisateur qui oubliait son mot de passe devait demander à un administrateur (ou au support) de
-- le changer. Il peut désormais recevoir par e-mail un lien à usage unique, valable 1 heure.
--
-- 100% additif : deux colonnes nullables, aucune donnée existante touchée. Même principe que la vérification
-- d'e-mail (migration-20) : seul le SHA-256 du jeton est stocké, le jeton en clair n'existe que dans l'e-mail.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS reset_expire_le TIMESTAMP;

-- Recherche du jeton à la validation du lien (index partiel : presque aucune ligne n'a une demande en cours).
CREATE INDEX IF NOT EXISTS idx_utilisateurs_reset_token ON utilisateurs (reset_token_hash) WHERE reset_token_hash IS NOT NULL;

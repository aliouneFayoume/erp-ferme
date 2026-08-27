-- ==============================================================================
-- MIGRATION 20 — Durcissement authentification : politique de mot de passe,
-- vérification d'email (Resend), MFA (TOTP ou WhatsApp), obligatoire pour les admin.
-- ==============================================================================
-- 100% additif. AUCUN compte existant ne doit être verrouillé : email_verifie et mfa_obligatoire
-- sont posés de façon à laisser tous les comptes déjà en production strictement inchangés
-- (voir le commentaire sur chaque colonne).

-- --- Vérification d'email --------------------------------------------------
-- Ajoutée avec DEFAULT TRUE : au moment où cette ligne s'exécute, TOUTE ligne d'utilisateurs
-- existante est par définition un compte déjà en production (grandfathering automatique, sans
-- UPDATE séparé). Le DEFAULT est ensuite changé à FALSE : seules les lignes insérées APRES cette
-- migration en hériteront, donc seuls les VRAIS nouveaux comptes devront vérifier leur email.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS email_verifie BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE utilisateurs ALTER COLUMN email_verifie SET DEFAULT FALSE;

-- SHA-256 hex du token (pas bcrypt : ce n'est pas un secret bas-débit choisi par un humain comme
-- un mot de passe, juste crypto.randomBytes(32) — un hash rapide suffit à empêcher qu'un dump
-- lecture-seule de la base permette de forger un lien de vérification valide).
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS email_verification_token_hash VARCHAR(64);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS email_verification_expire_le TIMESTAMP;

-- --- MFA --------------------------------------------------------------------
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_actif BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_methode VARCHAR(10);
DO $$ BEGIN
    ALTER TABLE utilisateurs ADD CONSTRAINT chk_mfa_methode CHECK (mfa_methode IS NULL OR mfa_methode IN ('TOTP', 'WHATSAPP'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Chiffré au repos via server/src/credentials.js (chiffrer/dechiffrer), même AES-256-GCM que
-- organisation_paydunya_config / organisation_whatsapp_config — jamais de secret TOTP en clair.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_totp_secret_chiffre TEXT;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_whatsapp_numero VARCHAR(20);

-- Indicateur "MFA obligatoire pour CE compte" — indépendant de mfa_actif. DEFAULT FALSE pour
-- TOUTES les lignes (existantes ET nouvelles) : ce n'est PAS un flag automatique par rôle, c'est
-- l'application (creerFerme.js, routes/utilisateurs.js) qui le pose explicitement à TRUE
-- uniquement à la création d'un compte admin APRES cette migration. Aucun admin déjà en
-- production n'est concerné, quel que soit son rôle.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_obligatoire BOOLEAN NOT NULL DEFAULT FALSE;

-- Code temporaire (6 chiffres) : partagé entre le défi de connexion WhatsApp ET la confirmation
-- d'activation WhatsApp — un seul flux MFA "en vol" par utilisateur à la fois. Même philosophie de
-- verrouillage que clients.pin_tentatives_echouees (portail.js), à l'échelle du compte plutôt que
-- par IP.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_code_hash VARCHAR(64);
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_code_expire_le TIMESTAMP;
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS mfa_code_tentatives INT NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (nom) VALUES ('migration-20-securite-auth.sql') ON CONFLICT (nom) DO NOTHING;

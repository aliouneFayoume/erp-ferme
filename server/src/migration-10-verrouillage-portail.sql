-- ==============================================================================
-- MIGRATION 10 — Verrouillage par compte sur le portail client (audit sécurité 2026-08-11, E1)
-- ==============================================================================
-- Un PIN à 6 chiffres a peu d'entropie ; la limite express-rate-limit existante (8 tentatives /
-- 15 min PAR IP) est contournable en distribuant les tentatives sur plusieurs IP (ex: script tournant
-- dans le navigateur de visiteurs tiers via CORS, corrigé au même commit — voir server/src/index.js).
-- Ce verrouillage est PAR COMPTE (numéro de téléphone), en plus de la limite par IP, pas à sa place.
--
-- 100% additif et rejouable : les deux colonnes ont des défauts neutres, aucun client existant
-- n'est affecté avant sa première tentative de connexion échouée après ce déploiement.
-- ==============================================================================

ALTER TABLE clients ADD COLUMN IF NOT EXISTS pin_tentatives_echouees INT NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pin_bloque_jusqu TIMESTAMPTZ;

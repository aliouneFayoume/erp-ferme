-- ==============================================================================
-- MIGRATION 12 — Dépôt GPS et informations de facturation par ferme (audit systèmes
-- 2026-08-11, item #13)
-- ==============================================================================
-- Avant cette migration, le dépôt de départ des tournées (routing.js) et l'en-tête de la facture
-- PDF (facturePdf.js) étaient codés en dur sur Ferme Massla (Diamniadio) pour TOUTES les fermes
-- clientes. 100% additif : colonnes nullables, aucune ferme existante n'est affectée tant qu'un
-- admin n'a pas renseigné ses propres valeurs via les réglages self-service
-- (routes/parametres-ferme.js) — une ferme sans dépôt configuré continue de se replier sur le
-- dépôt par défaut de routing.js.
-- ==============================================================================

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS gps_lat NUMERIC;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS gps_lng NUMERIC;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS adresse VARCHAR(255);
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS telephone VARCHAR(20);

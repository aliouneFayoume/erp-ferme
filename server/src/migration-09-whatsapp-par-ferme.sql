-- ==============================================================================
-- MIGRATION 09 — Identifiants WhatsApp propres à chaque ferme (hors Massla elle-même)
-- ==============================================================================
-- 100% additif et rejouable. organisations.est_plateforme identifie Ferme Massla (backfillée via
-- son slug — déjà unique et déjà en place, voir migration-07) : la seule organisation autorisée à
-- utiliser les identifiants WhatsApp globaux (server/.env) pour relancer SES PROPRES clients — voir
-- routes/finance.js. Toute autre ferme doit configurer les siens (organisation_whatsapp_config),
-- self-service, voir routes/parametres-whatsapp.js.
-- ==============================================================================

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS est_plateforme BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE organisations SET est_plateforme = TRUE WHERE slug = 'ferme-massla' AND est_plateforme = FALSE;

CREATE TABLE IF NOT EXISTS organisation_whatsapp_config (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    access_token_chiffre TEXT NOT NULL,
    phone_number_id_chiffre TEXT NOT NULL,
    template_nom VARCHAR(100) NOT NULL DEFAULT 'hello_world',
    template_langue VARCHAR(10) NOT NULL DEFAULT 'en_US',
    mis_a_jour_par INT REFERENCES utilisateurs(id),
    mis_a_jour_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

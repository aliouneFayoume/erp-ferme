-- ==============================================================================
-- MIGRATION 03 — Passage multi-tenant : Massla devient le tenant #1
-- ==============================================================================
-- 100% additif et rejouable sans risque : nouvelles tables, colonnes tenant_id NULLABLES sur les
-- tables existantes, puis rattachement de toutes les données déjà en base à l'organisation Massla.
-- Le code actuellement déployé (avant cette migration) ignore complètement tenant_id — l'exécuter
-- ne change AUCUN comportement observable tant que le nouveau code (celui de la branche
-- feature/multi-tenant-saas) n'est pas déployé par-dessus. Peut donc être exécutée à tout moment,
-- même en pleine journée, sans coupure de service ni changement visible pour les utilisateurs.
--
-- Ordre impératif pour un vrai passage en production, voir deploy/DEPLOIEMENT.md :
--   1. Exécuter CE fichier contre la base de prod (aucun impact, l'app tourne toujours avec l'ancien code)
--   2. Migrer les identifiants PayDunya actuels (server/.env) vers organisation_paydunya_config —
--      opération séparée (chiffrement fait en JS, pas en SQL), voir le runbook
--   3. Déployer le nouveau code (celui-là seul commence à utiliser tenant_id)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS organisations (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS organisation_paydunya_config (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    mode VARCHAR(10) CHECK (mode IN ('test', 'live')) NOT NULL DEFAULT 'test',
    master_key_chiffre TEXT NOT NULL,
    private_key_chiffre TEXT NOT NULL,
    public_key_chiffre TEXT NOT NULL,
    token_chiffre TEXT NOT NULL,
    mis_a_jour_par INT REFERENCES utilisateurs(id),
    mis_a_jour_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Colonnes tenant_id, nullables pour l'instant (backfill juste après) — l'ordre des tables suit
-- schema.sql. Les tables de lignes/messages (lignes_commande, lignes_commande_fournisseur,
-- ticket_messages, releves_journaliers, stocks) n'ont volontairement pas leur propre tenant_id :
-- elles s'isolent via leur table parente.
ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE abonnements ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE produits ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE livraisons ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE factures ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE paiements ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE caisses_chauffeur ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE depenses ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE releves_bancaires ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE fournisseurs ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE commandes_fournisseurs ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);

-- Généralisations liées au multi-tenant (secteurs libres par organisation au lieu de noms figés) :
-- voir dashboard.js / routes/production.js sur la branche. suivi_recolte remplace le test en dur
-- "nom = 'Maraîcher'" (une organisation peut avoir un secteur "Culture" ou autre nom).
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS suivi_recolte BOOLEAN DEFAULT FALSE;
UPDATE secteurs SET suivi_recolte = TRUE WHERE nom = 'Maraîcher' AND suivi_recolte IS NOT TRUE;

-- --------------------------------------------------------
-- Rattachement de toutes les données existantes à l'organisation Massla (idempotent : ne crée
-- l'organisation qu'une fois, ne touche que les lignes pas encore migrées).
-- --------------------------------------------------------

INSERT INTO organisations (nom)
SELECT 'Ferme Massla'
WHERE NOT EXISTS (SELECT 1 FROM organisations WHERE nom = 'Ferme Massla');

UPDATE utilisateurs SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE clients SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE abonnements SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE secteurs SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE lots_production SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE produits SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE commandes SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE livraisons SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE factures SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE paiements SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE caisses_chauffeur SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE depenses SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE releves_bancaires SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE fournisseurs SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE commandes_fournisseurs SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE tickets SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;
UPDATE audit_logs SET tenant_id = (SELECT id FROM organisations WHERE nom = 'Ferme Massla') WHERE tenant_id IS NULL;

-- --------------------------------------------------------
-- Remarque : activer RLS sur ces deux nouvelles tables se fait via enable-rls.sql (déjà mis à jour),
-- pas ici — même raison que pour le reste du schéma : pg-mem (dev local + suite de tests) ne sait
-- pas parser "ENABLE ROW LEVEL SECURITY", ce fichier doit donc en rester exempt pour rester testable.
-- --------------------------------------------------------
-- Vérification (à lancer manuellement après coup, pas automatisée ici) :
--   SELECT 'utilisateurs', COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM utilisateurs
--   UNION ALL SELECT 'clients', COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM clients
--   ... (une ligne par table ci-dessus) — chaque décompte doit valoir 0.
-- --------------------------------------------------------

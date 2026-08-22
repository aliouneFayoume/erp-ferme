-- ==============================================================================
-- MIGRATION 18 — Gestion des coûts agricoles, Immobilisations (amortissement), Paie
-- ==============================================================================
-- 1. equipements gagne un amortissement optionnel (durée + valeur résiduelle) et une nouvelle table
--    `amortissements` sert de ledger anti-double-comptage pour les dotations effectivement postées
--    en dépense. Le module "Matériel" devient conceptuellement "Immobilisations" (section de
--    l'onglet Comptabilité côté app — aucun changement de nom de table ici, additif uniquement).
-- 2. Nouveau module Paie : `employes` + `bulletins_paie` (les taux de charges sociales sont saisis
--    manuellement par le comptable, pas calculés par l'app — voir schema.sql).
-- 100% additif : nouvelles colonnes nullable / nouvelles tables, aucune ligne existante affectée.
-- ==============================================================================

ALTER TABLE equipements ADD COLUMN IF NOT EXISTS duree_amortissement_mois INT;
ALTER TABLE equipements ADD COLUMN IF NOT EXISTS valeur_residuelle NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS amortissements (
    id SERIAL PRIMARY KEY,
    equipement_id INT REFERENCES equipements(id) ON DELETE CASCADE,
    periode DATE NOT NULL,
    montant NUMERIC NOT NULL,
    depense_id INT REFERENCES depenses(id),
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (equipement_id, periode)
);

CREATE TABLE IF NOT EXISTS employes (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    nom_complet VARCHAR(150) NOT NULL,
    poste VARCHAR(100),
    telephone VARCHAR(30),
    date_embauche DATE,
    date_depart DATE,
    salaire_brut_mensuel NUMERIC,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bulletins_paie (
    id SERIAL PRIMARY KEY,
    employe_id INT REFERENCES employes(id) ON DELETE CASCADE,
    periode DATE NOT NULL,
    salaire_brut NUMERIC NOT NULL,
    charges_sociales NUMERIC NOT NULL DEFAULT 0,
    salaire_net NUMERIC NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('EN_ATTENTE', 'PAYE')) DEFAULT 'EN_ATTENTE',
    date_paiement DATE,
    depense_id INT REFERENCES depenses(id),
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employe_id, periode)
);

-- RLS : mêmes conventions que rls-policies.sql (fonction current_tenant_id() déjà créée lors de la
-- mise en place initiale de RLS — non redéclarée ici).
ALTER TABLE amortissements ENABLE ROW LEVEL SECURITY;
ALTER TABLE employes ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulletins_paie ENABLE ROW LEVEL SECURITY;

-- Table enfant sans tenant_id propre : filtre via son parent, même pattern que
-- lignes_commande_fournisseur (rls-policies.sql).
DROP POLICY IF EXISTS tenant_isolation ON amortissements;
CREATE POLICY tenant_isolation ON amortissements
    USING (EXISTS (SELECT 1 FROM equipements e WHERE e.id = amortissements.equipement_id AND e.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM equipements e WHERE e.id = amortissements.equipement_id AND e.tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_isolation ON employes;
CREATE POLICY tenant_isolation ON employes
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON bulletins_paie;
CREATE POLICY tenant_isolation ON bulletins_paie
    USING (EXISTS (SELECT 1 FROM employes emp WHERE emp.id = bulletins_paie.employe_id AND emp.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM employes emp WHERE emp.id = bulletins_paie.employe_id AND emp.tenant_id = current_tenant_id()));

INSERT INTO schema_migrations (nom) VALUES ('migration-18-couts-immobilisations-paie.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 01 — Module approvisionnement (fournisseurs, commandes d'achat)
-- ==============================================================================
-- migrate.js applique schema.sql en une seule fois à l'installation initiale d'une base ; il n'a
-- pas vocation à être rejoué contre une base déjà en production (CREATE TABLE échouerait sur les
-- tables existantes). Ce fichier ne contient QUE l'ajout net de ce module et est écrit de façon
-- idempotente (IF NOT EXISTS partout) : il peut être rejoué sans risque en cas de doute sur son
-- exécution précédente.
--
-- À exécuter UNE FOIS contre la base de production (Supabase → SQL Editor du projet, ou
-- `psql "$DATABASE_URL" -f server/src/migration-01-fournisseurs.sql`), avant de déployer le code
-- qui utilise ces tables (routes/fournisseurs.js) — voir deploy/DEPLOIEMENT.md.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS fournisseurs (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(150) NOT NULL,
    categorie VARCHAR(50),
    telephone VARCHAR(30),
    email VARCHAR(150),
    adresse TEXT,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS commandes_fournisseurs (
    id SERIAL PRIMARY KEY,
    numero_commande VARCHAR(20) UNIQUE NOT NULL,
    fournisseur_id INT REFERENCES fournisseurs(id),
    statut VARCHAR(20) CHECK (statut IN ('COMMANDEE', 'RECUE', 'ANNULEE')) DEFAULT 'COMMANDEE',
    date_commande DATE NOT NULL DEFAULT CURRENT_DATE,
    date_livraison_prevue DATE,
    date_livraison_reelle DATE,
    montant_total NUMERIC NOT NULL DEFAULT 0,
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lignes_commande_fournisseur (
    id SERIAL PRIMARY KEY,
    commande_fournisseur_id INT REFERENCES commandes_fournisseurs(id) ON DELETE CASCADE,
    produit_id INT REFERENCES produits(id),
    quantite NUMERIC NOT NULL,
    prix_unitaire NUMERIC NOT NULL,
    sous_total NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commandes_fournisseurs_statut ON commandes_fournisseurs(statut);

ALTER TABLE fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commandes_fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lignes_commande_fournisseur ENABLE ROW LEVEL SECURITY;

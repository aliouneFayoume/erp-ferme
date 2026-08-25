-- ==============================================================================
-- MIGRATION 19 — Élevage individuel (bovins/ovins/caprins) : suivi animal par animal
-- ==============================================================================
-- Contrairement à Avicole/Piscicole/Maraîcher (suivis par lot/effectif), un ruminant a une valeur
-- individuelle et une longue durée de vie : chaque animal a sa propre fiche (identifiant, poids
-- dans le temps, santé), avec suivi de la reproduction (gestation, mise-bas, généalogie mère→petit).
--
-- Nouveau concept : `secteurs.parent_secteur_id` (self-FK) — "Élevage" devient un secteur parent
-- (regroupement, ne porte aucun animal directement), avec "Bovins"/"Ovins"/"Caprins" comme
-- secteurs enfants (`suivi_individuel = TRUE`, ce sont eux qui portent réellement les animaux).
-- Avicole/Piscicole/Maraîcher restent des secteurs "plats" (parent_secteur_id = NULL), inchangés.
--
-- 100% additif : nouvelles colonnes nullable / nouvelles tables, aucune ligne existante affectée.
-- ==============================================================================

ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS parent_secteur_id INT REFERENCES secteurs(id);
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS suivi_individuel BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS reproductions (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    mere_id INT,
    pere_id INT,
    date_saillie DATE NOT NULL,
    date_mise_bas_prevue DATE,
    date_mise_bas_reelle DATE,
    nombre_petits INT,
    statut VARCHAR(15) CHECK (statut IN ('EN_COURS', 'MISE_BAS', 'ECHEC')) NOT NULL DEFAULT 'EN_COURS',
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS animaux (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    identifiant VARCHAR(30) NOT NULL,
    espece VARCHAR(10) CHECK (espece IN ('BOVIN', 'OVIN', 'CAPRIN')) NOT NULL,
    race VARCHAR(50),
    sexe VARCHAR(1) CHECK (sexe IN ('M', 'F')) NOT NULL,
    date_naissance DATE,
    mere_id INT REFERENCES animaux(id),
    reproduction_id INT REFERENCES reproductions(id),
    origine VARCHAR(10) CHECK (origine IN ('NE_FERME', 'ACHETE')) NOT NULL DEFAULT 'NE_FERME',
    statut VARCHAR(10) CHECK (statut IN ('VIVANT', 'VENDU', 'ABATTU', 'MORT')) NOT NULL DEFAULT 'VIVANT',
    date_sortie DATE,
    poids_initial_kg NUMERIC,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, identifiant)
);

CREATE INDEX IF NOT EXISTS idx_animaux_mere ON animaux(mere_id);
CREATE INDEX IF NOT EXISTS idx_animaux_secteur_statut ON animaux(secteur_id, statut);

DO $$ BEGIN
    ALTER TABLE reproductions ADD CONSTRAINT fk_reproductions_mere FOREIGN KEY (mere_id) REFERENCES animaux(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE reproductions ADD CONSTRAINT fk_reproductions_pere FOREIGN KEY (pere_id) REFERENCES animaux(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS releves_animal (
    id SERIAL PRIMARY KEY,
    animal_id INT REFERENCES animaux(id) ON DELETE CASCADE,
    utilisateur_id INT REFERENCES utilisateurs(id),
    date_releve DATE NOT NULL,
    type_evenement VARCHAR(20) CHECK (type_evenement IN ('PESEE', 'VACCINATION', 'TRAITEMENT', 'OBSERVATION')) NOT NULL,
    poids_kg NUMERIC,
    produit_utilise VARCHAR(150),
    notes TEXT,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- RLS : mêmes conventions que rls-policies.sql (fonction current_tenant_id() déjà créée lors de la
-- mise en place initiale de RLS — non redéclarée ici).
ALTER TABLE reproductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE animaux ENABLE ROW LEVEL SECURITY;
ALTER TABLE releves_animal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON reproductions;
CREATE POLICY tenant_isolation ON reproductions
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation ON animaux;
CREATE POLICY tenant_isolation ON animaux
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Table enfant sans tenant_id propre : filtre via son parent, même pattern que amortissements
-- (migration-18) / lignes_commande_fournisseur (rls-policies.sql).
DROP POLICY IF EXISTS tenant_isolation ON releves_animal;
CREATE POLICY tenant_isolation ON releves_animal
    USING (EXISTS (SELECT 1 FROM animaux a WHERE a.id = releves_animal.animal_id AND a.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM animaux a WHERE a.id = releves_animal.animal_id AND a.tenant_id = current_tenant_id()));

INSERT INTO schema_migrations (nom) VALUES ('migration-19-elevage-ruminants.sql')
ON CONFLICT (nom) DO NOTHING;

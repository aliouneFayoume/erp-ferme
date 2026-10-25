-- ==============================================================================
-- MIGRATION 41 — Module Ostréiculture, version de base (V1) : structures, relevés, récoltes à la douzaine
-- ==============================================================================
-- Le module réutilise les lots de production (une « structure suivie » = un lot : poche, guirlande, table, ligne…) et les relevés
-- journaliers ; cette migration ajoute le strict nécessaire (cahier des charges v0.1) :
--   * lots_production : site (zone, bolong, lagune), type de structure, origine du lot (captage, achat, cueillette) ;
--   * releves_journaliers : salinité (‰), naissain capté, nombre d'huîtres mesurées, entretien effectué ;
--   * produits.unite_mesure : nouvelle unité « DOUZAINE » (vente de l'huître fraîche) ;
--   * recoltes_ostreicoles : récoltes d'une structure (douzaines, nombre, calibres, destination), sous RLS de tenant.
--
-- 100% additif et rejouable. La contrainte d'unité des produits est retrouvée par son contenu (son nom peut varier selon la
-- base) puis recréée avec « DOUZAINE ».
-- ==============================================================================

ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS site VARCHAR(100);
ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS type_structure VARCHAR(20);
ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS origine_lot VARCHAR(20);

ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS salinite_ppt NUMERIC;
ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS naissain_capte INT;
ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS nb_mesures INT;
ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS entretien VARCHAR(60);

DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'produits'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%unite_mesure%'
    LOOP
        EXECUTE format('ALTER TABLE produits DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE produits ADD CONSTRAINT produits_unite_mesure_check
        CHECK (unite_mesure IN ('TETE', 'KG', 'CAISSE', 'BOTTES', 'DOUZAINE'));
END $$;

CREATE TABLE IF NOT EXISTS recoltes_ostreicoles (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    lot_id INT NOT NULL REFERENCES lots_production(id),
    date_recolte DATE NOT NULL DEFAULT CURRENT_DATE,
    douzaines NUMERIC NOT NULL CHECK (douzaines >= 0),
    nombre INT NOT NULL CHECK (nombre >= 0),
    kg NUMERIC,
    calibre_0 INT,
    calibre_1 INT,
    calibre_2 INT,
    calibre_3 INT,
    destination VARCHAR(20) NOT NULL DEFAULT 'FRAIS' CHECK (destination IN ('FRAIS', 'TRANSFORMATION', 'FAMILLE')),
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recoltes_ostreicoles_lot ON recoltes_ostreicoles (lot_id);

ALTER TABLE recoltes_ostreicoles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON recoltes_ostreicoles;
CREATE POLICY tenant_isolation ON recoltes_ostreicoles
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

INSERT INTO schema_migrations (nom) VALUES ('migration-41-ostreiculture.sql')
ON CONFLICT (nom) DO NOTHING;

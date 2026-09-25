-- ==============================================================================
-- MIGRATION 29 — Déplacement de poissons entre bassins (historique des mouvements)
-- ==============================================================================
-- Retour de Clovis (Fish Feed Burkina, 2026-09-24) : les bassins sont permanents et gardent leur type ; ce sont
-- les poissons qui passent d'un bassin à l'autre (éclosion → élevage larvaire → prégrossissement). Chaque
-- déplacement ajuste l'effectif des deux bassins (lots_production.quantite_initiale, qui est l'« effectif
-- actuel ») et l'espèce (migration-28) ; cette table en garde la trace pour qu'on sache d'où viennent les
-- poissons d'un bassin et quand ils y sont arrivés.
--
-- 100% additif : une nouvelle table, aucune colonne existante touchée. Sous RLS de tenant comme les autres
-- tables métier.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS mouvements_bassins (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    lot_source_id INT NOT NULL REFERENCES lots_production(id),
    lot_destination_id INT NOT NULL REFERENCES lots_production(id),
    quantite INT NOT NULL CHECK (quantite > 0),
    espece VARCHAR(100), -- espèce des poissons déplacés (celle du bassin de départ à ce moment-là)
    date_mouvement DATE NOT NULL,
    effectif_source_apres INT NOT NULL,
    effectif_destination_apres INT NOT NULL,
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mouvements_bassins_tenant_date ON mouvements_bassins (tenant_id, date_mouvement DESC);

ALTER TABLE mouvements_bassins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON mouvements_bassins;
CREATE POLICY tenant_isolation ON mouvements_bassins
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

INSERT INTO schema_migrations (nom) VALUES ('migration-29-mouvements-bassins.sql')
ON CONFLICT (nom) DO NOTHING;

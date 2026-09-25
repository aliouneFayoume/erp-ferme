-- ==============================================================================
-- MIGRATION 28 — Espèce présente dans un bassin (Piscicole)
-- ==============================================================================
-- Retour de Clovis (Fish Feed Burkina, 2026-09-24) : les bassins sont permanents et gardent leur type
-- (éclosion / élevage larvaire / prégrossissement) ; ce sont les poissons, donc l'espèce, qui passent de
-- bassin en bassin. Une colonne texte libre sur le lot (= le bassin) : espèce actuellement dedans.
--
-- 100% additif : une colonne nullable, aucune ligne existante affectée, aucune policy RLS à toucher
-- (lots_production est déjà sous tenant_isolation).
-- ==============================================================================

ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS espece VARCHAR(100);

INSERT INTO schema_migrations (nom) VALUES ('migration-28-espece-lot.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 24 — Ramassage des œufs (Avicole) → stock vendable automatique
-- ==============================================================================
-- 100% additif. Jusqu'ici, le relevé journalier d'un lot Avicole ne suivait ni la quantité d'œufs
-- ramassés, ni ne l'associait au stock vendable du produit "Œufs" du catalogue (contrairement au
-- Maraîcher, qui a déjà quantite_recoltee_kg) — le stock devait être remis à jour à la main.

ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS oeufs_collectes INT;

-- "Produit œufs par défaut" d'un secteur : quand renseigné, chaque relevé journalier avec
-- oeufs_collectes > 0 pour un lot de ce secteur incrémente automatiquement le stock de ce produit,
-- converti en plateaux (routes/production.js, POST /sync).
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS produit_oeufs_id INT REFERENCES produits(id);
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS oeufs_par_plateau INT NOT NULL DEFAULT 30 CHECK (oeufs_par_plateau > 0);
-- Reste non conditionné (< 1 plateau) reporté d'un relevé à l'autre : ex. 45 œufs collectés en un
-- jour = 1 plateau ajouté au stock + 15 œufs reportés en attente du lendemain, jamais perdus à
-- l'arrondi.
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS oeufs_non_conditionnes INT NOT NULL DEFAULT 0;

INSERT INTO schema_migrations (nom) VALUES ('migration-24-ramassage-oeufs.sql')
ON CONFLICT (nom) DO NOTHING;

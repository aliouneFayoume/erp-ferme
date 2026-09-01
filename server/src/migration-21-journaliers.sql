-- ==============================================================================
-- MIGRATION 21 — Gestion des journaliers (paie à la journée)
-- ==============================================================================
-- 100% additif. Les employés existants restent 'MENSUEL' (défaut), aucune ligne n'est modifiée.
-- Le bulletin de paie (bulletins_paie) n'est PAS modifié : c'est le frontend qui calcule
-- salaire_brut = jours_travailles x taux_journalier avant d'appeler POST /bulletins (route déjà
-- existante et testée, voir routes/paie.js et migration-18).

ALTER TABLE employes ADD COLUMN IF NOT EXISTS type_contrat VARCHAR(10) NOT NULL DEFAULT 'MENSUEL'
    CHECK (type_contrat IN ('MENSUEL', 'JOURNALIER'));
ALTER TABLE employes ADD COLUMN IF NOT EXISTS taux_journalier NUMERIC;

-- Une ligne = un jour travaillé ; l'absence de ligne pour (employe_id, date_pointage) = absent.
CREATE TABLE IF NOT EXISTS pointages_journaliers (
    id SERIAL PRIMARY KEY,
    employe_id INT REFERENCES employes(id) ON DELETE CASCADE,
    date_pointage DATE NOT NULL,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employe_id, date_pointage)
);

-- RLS : mêmes conventions que rls-policies.sql / migration-18 (fonction current_tenant_id() déjà
-- créée lors de la mise en place initiale de RLS — non redéclarée ici).
ALTER TABLE pointages_journaliers ENABLE ROW LEVEL SECURITY;

-- Table enfant sans tenant_id propre : filtre via son parent, même pattern que bulletins_paie.
DROP POLICY IF EXISTS tenant_isolation ON pointages_journaliers;
CREATE POLICY tenant_isolation ON pointages_journaliers
    USING (EXISTS (SELECT 1 FROM employes emp WHERE emp.id = pointages_journaliers.employe_id AND emp.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM employes emp WHERE emp.id = pointages_journaliers.employe_id AND emp.tenant_id = current_tenant_id()));

INSERT INTO schema_migrations (nom) VALUES ('migration-21-journaliers.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 17 — Module Matériel (inventaire, entretien, suivi financier)
-- ==============================================================================
-- Nouveau module : inventaire du matériel (tracteurs, pompes, cages, outils...),
-- rattachement optionnel à un secteur et/ou un fournisseur, historique des entretiens, et
-- génération automatique d'une dépense (table `depenses`) quand un entretien a un coût.
-- 100% additif : nouvelles tables, aucune ligne existante affectée.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS equipements (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    fournisseur_id INT REFERENCES fournisseurs(id),
    nom VARCHAR(150) NOT NULL,
    categorie VARCHAR(50),
    etat VARCHAR(20) CHECK (etat IN ('Bon', 'A réparer', 'Hors service')) DEFAULT 'Bon',
    quantite INT NOT NULL DEFAULT 1,
    date_achat DATE,
    valeur_achat NUMERIC,
    prochain_entretien DATE,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entretiens_equipement (
    id SERIAL PRIMARY KEY,
    equipement_id INT REFERENCES equipements(id) ON DELETE CASCADE,
    date_entretien DATE NOT NULL,
    description TEXT,
    cout NUMERIC,
    prochain_entretien DATE,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_equipements_prochain_entretien ON equipements(prochain_entretien);

-- RLS : mêmes conventions que rls-policies.sql (fonction current_tenant_id() déjà créée par ce
-- fichier lors de la mise en place initiale de RLS — non redéclarée ici).
ALTER TABLE equipements ENABLE ROW LEVEL SECURITY;
ALTER TABLE entretiens_equipement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON equipements;
CREATE POLICY tenant_isolation ON equipements
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Table enfant sans tenant_id propre : filtre via son parent, même pattern que
-- lignes_commande_fournisseur (rls-policies.sql).
DROP POLICY IF EXISTS tenant_isolation ON entretiens_equipement;
CREATE POLICY tenant_isolation ON entretiens_equipement
    USING (EXISTS (SELECT 1 FROM equipements e WHERE e.id = entretiens_equipement.equipement_id AND e.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM equipements e WHERE e.id = entretiens_equipement.equipement_id AND e.tenant_id = current_tenant_id()));

INSERT INTO schema_migrations (nom) VALUES ('migration-17-equipements.sql')
ON CONFLICT (nom) DO NOTHING;

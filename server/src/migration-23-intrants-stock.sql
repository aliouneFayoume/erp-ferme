-- ==============================================================================
-- MIGRATION 23 — Stock d'intrants (aliment, engrais, phytosanitaires, vétérinaire...)
-- ==============================================================================
-- Jusqu'ici, les intrants n'étaient suivis qu'à moitié : à l'achat (lignes_commande_fournisseur,
-- désignation en texte libre) et à l'usage (releves_journaliers.conso_aliment_kg / intrants_utilises,
-- un simple nombre/texte, jamais déduit de quoi que ce soit) — sans jamais se rejoindre en un stock
-- réel ("il vous reste X kg"). 100% additif : nouvelles tables + colonnes nullable, aucune ligne
-- existante affectée.
--
-- quantite_stock est mise à jour UNIQUEMENT via des mouvements (jamais modifiée directement) pour
-- garder un historique auditable — même esprit que `stocks`, mais avec un vrai grand livre.

CREATE TABLE IF NOT EXISTS intrants (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    nom VARCHAR(150) NOT NULL,
    -- IS NULL OR ... explicite : categorie est optionnelle et pg-mem (tests) rejette à tort une
    -- ligne NULL sur un simple CHECK IN, contrairement à PostgreSQL (voir schema.sql).
    categorie VARCHAR(30) CHECK (categorie IS NULL OR categorie IN ('Aliment', 'Engrais', 'Phytosanitaire', 'Vétérinaire', 'Semences', 'Autre')),
    unite VARCHAR(30) NOT NULL,
    quantite_stock NUMERIC NOT NULL DEFAULT 0,
    seuil_alerte NUMERIC,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Grand livre des mouvements — jamais modifié/supprimé après coup. motif distingue une saisie
-- manuelle d'une réception de commande fournisseur (entrées), et une saisie manuelle d'une
-- déduction automatique déclenchée par un relevé journalier (sorties).
CREATE TABLE IF NOT EXISTS mouvements_intrants (
    id SERIAL PRIMARY KEY,
    intrant_id INT REFERENCES intrants(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL CHECK (type IN ('ENTREE', 'SORTIE')),
    quantite NUMERIC NOT NULL CHECK (quantite > 0),
    motif VARCHAR(30) NOT NULL CHECK (motif IN ('MANUEL', 'RECEPTION_COMMANDE', 'RELEVE_JOURNALIER', 'AJUSTEMENT')),
    lot_id INT REFERENCES lots_production(id),
    commande_fournisseur_id INT REFERENCES commandes_fournisseurs(id),
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lien optionnel d'une ligne d'achat vers le stock : seule une ligne qui EST un intrant (pas du
-- matériel ou un service) alimente le stock à la réception (routes/fournisseurs.js).
ALTER TABLE lignes_commande_fournisseur ADD COLUMN IF NOT EXISTS intrant_id INT REFERENCES intrants(id);

-- "Aliment par défaut" d'un secteur Avicole/Piscicole : quand renseigné, chaque relevé journalier
-- avec un aliment consommé > 0 pour un lot de ce secteur déduit automatiquement cette quantité de
-- cet intrant (routes/production.js, POST /sync) — évite une double saisie manuelle.
ALTER TABLE secteurs ADD COLUMN IF NOT EXISTS intrant_alimentation_id INT REFERENCES intrants(id);

-- RLS : mêmes conventions que migration-19/rls-policies.sql (fonction current_tenant_id() déjà
-- créée lors de la mise en place initiale de RLS — non redéclarée ici).
ALTER TABLE intrants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mouvements_intrants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON intrants;
CREATE POLICY tenant_isolation ON intrants
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Table enfant sans tenant_id propre : filtre via son parent, même pattern que releves_animal
-- (migration-19) / amortissements (migration-18).
DROP POLICY IF EXISTS tenant_isolation ON mouvements_intrants;
CREATE POLICY tenant_isolation ON mouvements_intrants
    USING (EXISTS (SELECT 1 FROM intrants i WHERE i.id = mouvements_intrants.intrant_id AND i.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM intrants i WHERE i.id = mouvements_intrants.intrant_id AND i.tenant_id = current_tenant_id()));

INSERT INTO schema_migrations (nom) VALUES ('migration-23-intrants-stock.sql')
ON CONFLICT (nom) DO NOTHING;

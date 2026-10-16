-- ==============================================================================
-- MIGRATION 36 — Bilan par lot : ce que chaque lot rapporte (Easystart, phase 4)
-- ==============================================================================
-- Jusqu'ici l'application savait combien un lot consomme d'aliment (FCR) mais pas ce qu'il rapporte : les ventes n'étaient pas
-- rattachées à un lot, et ni les poussins ni les frais n'étaient comptés par lot. Cette migration ajoute le strict nécessaire :
--   * lignes_commande.lot_id (facultatif) : de quel lot viennent les sujets vendus sur cette ligne de commande ;
--   * lots_production.prix_aliment_kg : prix moyen du kg d'aliment de ce lot, saisi une fois (ex. sac de 25 kg à 14 500 FCFA = 580) ;
--   * couts_lot : autres coûts saisis par lot (poussins, vaccins/vétérinaire, main-d'œuvre, transport, autre) — dans l'écran
--     Production, donc disponibles dès l'essai gratuit (la comptabilité n'en fait pas partie) ;
--   * est_demo sur clients / produits / commandes : la ferme démo d'un essai (migration-35) a désormais des ventes, créées
--     pour montrer un bilan complet ; elles se suppriment avec le lot démo, en un clic.
--
-- 100% additif et rejouable : aucune ligne existante modifiée. La nouvelle table est sous RLS de tenant, comme les autres.
-- ==============================================================================

ALTER TABLE lots_production ADD COLUMN IF NOT EXISTS prix_aliment_kg NUMERIC;
ALTER TABLE lignes_commande ADD COLUMN IF NOT EXISTS lot_id INT REFERENCES lots_production(id);
CREATE INDEX IF NOT EXISTS idx_lignes_commande_lot ON lignes_commande (lot_id);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS est_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE produits ADD COLUMN IF NOT EXISTS est_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE commandes ADD COLUMN IF NOT EXISTS est_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS couts_lot (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    lot_id INT NOT NULL REFERENCES lots_production(id),
    categorie VARCHAR(30) NOT NULL CHECK (categorie IN ('Poussins', 'Vétérinaire', 'Main d''œuvre', 'Transport', 'Autre')),
    libelle VARCHAR(150),
    montant NUMERIC NOT NULL CHECK (montant >= 0),
    date_cout DATE NOT NULL DEFAULT CURRENT_DATE,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_couts_lot_lot ON couts_lot (lot_id);

ALTER TABLE couts_lot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON couts_lot;
CREATE POLICY tenant_isolation ON couts_lot
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

INSERT INTO schema_migrations (nom) VALUES ('migration-36-bilan-lot.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 42 — Sécurité des commandes : quantités strictement positives
-- ==============================================================================
-- Audit sécurité : une quantité négative sur une ligne de commande ou un abonnement « créait » du stock
-- et faussait les montants. Le serveur la refuse désormais (routes/commandes.js, routes/abonnements.js) ;
-- cette migration ajoute la même règle en base, en dernier rempart.
--
-- Les contraintes sont créées en NOT VALID : elles s'appliquent à toute nouvelle ligne ou modification,
-- mais ne vérifient pas les lignes déjà présentes (qui ne feront donc jamais échouer la migration).
--
-- 100% additive et rejouable : chaque contrainte n'est ajoutée que si elle n'existe pas encore.
-- ==============================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lignes_commande_quantite_positive') THEN
        ALTER TABLE lignes_commande ADD CONSTRAINT lignes_commande_quantite_positive CHECK (quantite > 0) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abonnements_quantite_positive') THEN
        ALTER TABLE abonnements ADD CONSTRAINT abonnements_quantite_positive CHECK (quantite > 0) NOT VALID;
    END IF;
END $$;

INSERT INTO schema_migrations (nom) VALUES ('migration-42-securite-commandes.sql')
ON CONFLICT (nom) DO NOTHING;

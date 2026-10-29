-- ==============================================================================
-- MIGRATION 46 — Programme d'affiliation : partenaires, rattachement des fermes, versements
-- ==============================================================================
-- Un partenaire (ex. un ingénieur agronome influenceur, code « TERANGA ») recommande Massla à son audience. Les inscrits
-- ouvrent l'essai gratuit de 30 jours par le parcours habituel et peuvent y saisir son « code partenaire » (ou arriver par un
-- lien ?ref=CODE). Le code ne donne AUCUN avantage à l'inscrit : il sert uniquement à rattacher la ferme au partenaire.
-- Le partenaire n'est rémunéré que sur les PAIEMENTS RÉELS de l'abonnement (paiements_saas au statut VALIDE), pendant
-- `commission_mois` mois après la création de chaque ferme ; les versements déjà faits sont notés dans versements_partenaires.
--
--   - partenaires              : le code (UNIQUE, stocké en MAJUSCULES), le nom, le pourcentage et la durée de commission.
--   - versements_partenaires   : chaque somme réellement versée à un partenaire (sert à calculer le « reste dû »).
--   - organisations.partenaire_id / code_partenaire_saisi : la ferme rattachée, et ce que la personne a tapé (audit).
--
-- RLS : Supabase active la RLS d'office sur toute nouvelle table, et SANS policy toute lecture/écriture de erp_app est refusée
-- en silence (vu avec avis_publics, migration-32). Les policies sont donc écrites ici, explicitement. Les deux tables sont
-- réservées au superviseur plateforme (is_plateforme_admin()) : la vérification d'un code à l'inscription (aucune ferme, donc
-- aucun contexte tenant) passe par le contexte plateforme ouvert par queryPreTenantPlateforme, sans policy « pré-tenant »
-- plus large qui laisserait n'importe quelle requête sans ferme lire la liste des partenaires et leurs taux. Aucune policy
-- DELETE : un partenaire se désactive, il ne s'efface pas (l'historique des fermes rattachées reste lisible).
-- Les rôles anon / authenticated (API REST publique) n'ont aucun droit : on ne leur en redonne pas (migration-43).
--
-- 100% additif et rejouable : aucune ligne existante modifiée.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS partenaires (
    id SERIAL PRIMARY KEY,
    code VARCHAR(40) NOT NULL UNIQUE, -- toujours en MAJUSCULES : [A-Z0-9_-], vérifié par le serveur avant l'insertion
    nom VARCHAR(100) NOT NULL,
    commission_pct INT NOT NULL DEFAULT 20 CHECK (commission_pct >= 0 AND commission_pct <= 100),
    commission_mois INT NOT NULL DEFAULT 12 CHECK (commission_mois >= 0), -- durée de la commission, en mois après la création de chaque ferme
    actif BOOLEAN NOT NULL DEFAULT TRUE, -- un partenaire inactif n'est plus accepté à l'inscription ; ses fermes déjà rattachées restent les siennes
    notes TEXT,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS versements_partenaires (
    id SERIAL PRIMARY KEY,
    partenaire_id INT NOT NULL REFERENCES partenaires(id),
    montant_fcfa INT NOT NULL CHECK (montant_fcfa > 0),
    date_versement DATE NOT NULL DEFAULT CURRENT_DATE,
    note TEXT,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_versements_partenaires_partenaire ON versements_partenaires (partenaire_id);

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS partenaire_id INT REFERENCES partenaires(id);
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS code_partenaire_saisi VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_organisations_partenaire ON organisations (partenaire_id);

ALTER TABLE partenaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE versements_partenaires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plateforme_seulement ON partenaires;
CREATE POLICY plateforme_seulement ON partenaires TO erp_app
    USING (is_plateforme_admin())
    WITH CHECK (is_plateforme_admin());

DROP POLICY IF EXISTS plateforme_seulement ON versements_partenaires;
CREATE POLICY plateforme_seulement ON versements_partenaires TO erp_app
    USING (is_plateforme_admin())
    WITH CHECK (is_plateforme_admin());

INSERT INTO schema_migrations (nom) VALUES ('migration-46-partenaires.sql')
ON CONFLICT (nom) DO NOTHING;

-- Vérification : les deux tables existent avec la RLS activée (true / true) et une policy chacune ; les deux colonnes sont sur organisations ;
-- et erp_app peut bien lire (is_plateforme_admin() reste faux hors du contexte plateforme : la lecture directe y renvoie 0 ligne, c'est voulu).
-- SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relname IN ('partenaires', 'versements_partenaires');
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename IN ('partenaires', 'versements_partenaires');
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'organisations' AND column_name IN ('partenaire_id', 'code_partenaire_saisi');
-- SELECT nom FROM schema_migrations WHERE nom = 'migration-46-partenaires.sql';

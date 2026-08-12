-- ==============================================================================
-- MIGRATION 15 — Registre des migrations SQL (audit systèmes/développement 2026-08-11,
-- liste "Ensuite" : "Registre de migrations SQL... pour rollback rapide")
-- ==============================================================================
-- Constat : les migrations 01 à 14 ont toutes été appliquées à la main (copier-coller dans le SQL
-- Editor de Supabase), sans aucune trace en base de CE QUI a été appliqué ni QUAND — seule la
-- mémoire de conversation en faisait foi. Cette table devient la source de vérité : chaque futur
-- fichier migration-NN-*.sql doit se terminer par son propre INSERT (voir modèle en bas de ce
-- fichier), pour que "quel est l'état réel de la base ?" ait toujours une réponse en une requête,
-- sans dépendre de la mémoire de qui que ce soit.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    nom TEXT PRIMARY KEY,
    appliquee_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill des migrations 01-14, déjà appliquées avant l'existence de cette table — appliquee_le
-- vaut donc la date de CETTE migration (15), pas la date réelle historique de chacune (perdue,
-- jamais enregistrée). À partir d'ici, chaque nouvelle migration s'enregistre elle-même avec sa
-- vraie date d'application.
INSERT INTO schema_migrations (nom) VALUES
    ('migration-01-fournisseurs.sql'),
    ('migration-02-fournisseurs-intrants.sql'),
    ('migration-03-multi-tenant.sql'),
    ('migration-04-superviseur-plateforme.sql'),
    ('migration-05-facturation-saas.sql'),
    ('migration-06-suppression-ferme.sql'),
    ('migration-07-organisations-slug.sql'),
    ('migration-08-whatsapp-contact.sql'),
    ('migration-09-whatsapp-par-ferme.sql'),
    ('migration-10-verrouillage-portail.sql'),
    ('migration-11-token-version.sql'),
    ('migration-12-info-ferme.sql'),
    ('migration-13-verification-croisee-ipn.sql'),
    ('migration-14-unique-par-tenant.sql')
ON CONFLICT (nom) DO NOTHING;

INSERT INTO schema_migrations (nom) VALUES ('migration-15-registre-migrations.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MODÈLE pour toute nouvelle migration-NN-*.sql à partir d'ici — dernière ligne du fichier :
--
--   INSERT INTO schema_migrations (nom) VALUES ('migration-NN-nom-du-fichier.sql')
--   ON CONFLICT (nom) DO NOTHING;
--
-- Vérifier l'état réel de la base à tout moment :
--   SELECT nom, appliquee_le FROM schema_migrations ORDER BY appliquee_le;
-- ==============================================================================

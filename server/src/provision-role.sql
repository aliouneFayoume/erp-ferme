-- ==============================================================================
-- RÔLE APPLICATIF NON-PROPRIÉTAIRE (prérequis pour que RLS s'applique réellement)
-- ==============================================================================
-- L'application se connecte aujourd'hui avec le rôle propriétaire des tables (ex: "postgres" sur
-- Supabase), qui CONTOURNE Row-Level Security par défaut, quelles que soient les policies définies
-- (voir enable-rls.sql, rls-policies.sql). Pour que RLS ait un effet réel, l'application doit se
-- connecter avec un rôle qui n'est ni propriétaire, ni superuser, ni BYPASSRLS.
--
-- Usage : coller ce fichier dans l'éditeur SQL Supabase (ou psql contre la vraie base), APRÈS avoir
-- remplacé <MOT_DE_PASSE_A_GENERER> par une vraie valeur générée avec :
--     openssl rand -base64 32
-- Ne jamais committer le mot de passe réel — ce fichier ne doit contenir que le placeholder.
-- Purement additif : tant que DATABASE_URL de l'application continue de pointer sur le rôle
-- propriétaire, ce script n'a aucun effet sur l'application qui tourne (voir DEPLOIEMENT.md,
-- Phase B du plan RLS, pour la bascule elle-même).
-- ==============================================================================

CREATE ROLE erp_app LOGIN PASSWORD '<MOT_DE_PASSE_A_GENERER>';

GRANT USAGE ON SCHEMA public TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO erp_app;
-- Nécessaire pour que les INSERT ... RETURNING sur des colonnes SERIAL fonctionnent (nextval()
-- exige USAGE sur la séquence sous-jacente, pas seulement sur la table).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_app;

-- Pour que les tables/séquences créées par de futures migrations (exécutées par le rôle
-- propriétaire) héritent automatiquement des mêmes droits, sans avoir à relancer ce script.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO erp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO erp_app;

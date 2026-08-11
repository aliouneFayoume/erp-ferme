-- ==============================================================================
-- RÔLE DÉDIÉ AUX SAUVEGARDES (lecture seule, BYPASSRLS) — jamais utilisé par l'application
-- ==============================================================================
-- Constat production 2026-08-11 : deploy/backup.sh utilisait DATABASE_URL (rôle erp_app, durci pour
-- RLS — voir provision-role.sql) pour pg_dump. Postgres refuse par défaut de laisser un rôle non
-- propriétaire et soumis à RLS faire un COPY complet d'une table à policies ("query would be
-- affected by row-level security policy"), plutôt que de produire silencieusement un dump partiel.
-- Résultat : aucune sauvegarde utilisable pendant ~77h avant que ce ne soit détecté et corrigé.
--
-- erp_app ne doit JAMAIS avoir BYPASSRLS : ce serait désactiver RLS pour l'application elle-même,
-- exactement l'isolation multi-tenant que RLS existe pour garantir. La solution est un second rôle,
-- strictement en lecture seule, dédié uniquement à pg_dump, jamais référencé par le code applicatif.
--
-- Usage : coller ce fichier dans l'éditeur SQL Supabase, APRÈS avoir remplacé
-- <MOT_DE_PASSE_A_GENERER> par une vraie valeur générée avec :
--     openssl rand -base64 32
-- Ne jamais committer le mot de passe réel — ce fichier ne doit contenir que le placeholder.
-- Ensuite, définir BACKUP_DATABASE_URL dans server/.env sur le VPS (même hôte/port/base que
-- DATABASE_URL, utilisateur/mot de passe différents) — voir DEPLOIEMENT.md, section "Sauvegardes".
-- ==============================================================================

CREATE ROLE erp_backup LOGIN PASSWORD '<MOT_DE_PASSE_A_GENERER>' BYPASSRLS;

GRANT USAGE ON SCHEMA public TO erp_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO erp_backup;
-- pg_dump lit aussi la valeur courante de chaque séquence (SELECT last_value, is_called FROM ...) :
-- sans ce GRANT, distinct de celui sur les tables, pg_dump échoue avec "permission denied for
-- sequence ..." dès la première table à colonne SERIAL. Trouvé en production 2026-08-11.
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO erp_backup;

-- Pour que les tables/séquences créées par de futures migrations héritent automatiquement du même
-- droit de lecture, sans avoir à relancer ce script.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO erp_backup;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO erp_backup;

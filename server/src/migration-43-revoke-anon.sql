-- ==============================================================================
-- MIGRATION 43 — Fermer l'API publique Supabase (rôles anon / authenticated) sur les données métier
-- ==============================================================================
-- Constat d'audit (2026-10-27) : anon et authenticated avaient les droits SELECT sur les tables du schéma public. Or plusieurs
-- règles RLS de lecture (utilisateurs, clients, organisations, paiements) contiennent « OR current_tenant_id() IS NULL » pour
-- les requêtes pré-tenant du serveur : une requête venue de l'API REST publique (clé anon, visible dans les pages web) n'a pas
-- de contexte de ferme, donc passait cette condition et pouvait lire toutes les fermes. La table roles est en « USING (true) ».
--
-- L'application se connecte uniquement avec le rôle erp_app (et la sauvegarde avec erp_backup) : elle n'utilise jamais
-- anon ni authenticated. On retire donc tous leurs droits sur le schéma public, y compris pour les tables futures.
-- Rejouable sans risque. Les rôles erp_app, erp_backup et le propriétaire ne sont pas touchés.
-- ==============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Tables créées plus tard par le propriétaire (Supabase accorde ces droits par défaut sur chaque nouvelle table).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

DO $$
BEGIN
    -- Même réglage pour les objets créés par le rôle postgres (propriétaire habituel des migrations Supabase).
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
        ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
    END IF;
END $$;

INSERT INTO schema_migrations (nom) VALUES ('migration-43-revoke-anon.sql')
ON CONFLICT (nom) DO NOTHING;

-- Vérification (doit renvoyer false / false partout) :
-- SELECT t.tablename,
--        has_table_privilege('anon', 'public.' || t.tablename, 'SELECT') AS anon_lit,
--        has_table_privilege('authenticated', 'public.' || t.tablename, 'SELECT') AS authenticated_lit
-- FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename IN ('utilisateurs','clients','commandes','factures')
-- ORDER BY 1;

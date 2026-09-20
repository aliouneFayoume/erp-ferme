-- ==============================================================================
-- MIGRATION 26 — Panneau "Activité des fermes" (Support plateforme)
-- ==============================================================================
-- Aucune table ni colonne : uniquement la policy RLS de LECTURE du journal d'audit, ouverte au
-- superviseur plateforme (is_plateforme_admin()) pour qu'il voie quand chaque ferme se connecte et
-- ce qu'elle saisit. La route (GET /api/plateforme/activite) n'agrège que des compteurs et des
-- dates, jamais audit_logs.details. Écriture / modification / suppression restent strictes.
DROP POLICY IF EXISTS tenant_isolation_select ON audit_logs;
CREATE POLICY tenant_isolation_select ON audit_logs FOR SELECT
    USING (tenant_id = current_tenant_id() OR is_plateforme_admin());

INSERT INTO schema_migrations (nom) VALUES ('migration-26-activite-plateforme.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 45 — Table `roles` en lecture seule pour l'application
-- ==============================================================================
-- Constat d'audit : la table roles (admin, comptable, chef_prod, livreur) avait la policy `allow_all ... USING (true) WITH CHECK (true)`,
-- donc le rôle applicatif erp_app pouvait y INSÉRER, MODIFIER ou SUPPRIMER des lignes (créer un rôle fantôme, renommer « admin »…).
-- Or aucune route de l'application n'écrit dans roles : elle ne fait que la LIRE (routes/utilisateurs.js, creerFerme.js,
-- creerFermeEssai.js). Les seules écritures sont seed.js, qui ne s'exécute que sur la base en mémoire de développement (pg-mem,
-- sans DATABASE_URL), et les migrations, jouées par le propriétaire des tables (qui n'est pas soumis aux policies).
--
-- Cette migration :
--   1. remplace la policy par une policy de LECTURE seule (FOR SELECT) : sans policy d'écriture, toute écriture de erp_app est refusée ;
--   2. retire aussi les droits INSERT/UPDATE/DELETE de erp_app sur roles (défense en profondeur, si la policy était un jour modifiée).
--      Garde « IF EXISTS » : sans effet sur une base où erp_app n'existe pas (développement).
-- Les migrations et le propriétaire des tables ne sont pas touchés. erp_backup (BYPASSRLS, lecture seule) non plus.
-- Rejouable sans risque. Rien d'autre que la table roles n'est modifié.
-- ==============================================================================

DROP POLICY IF EXISTS allow_all ON roles;
DROP POLICY IF EXISTS roles_lecture ON roles;
CREATE POLICY roles_lecture ON roles FOR SELECT USING (true);

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
        REVOKE INSERT, UPDATE, DELETE ON roles FROM erp_app;
    END IF;
END $$;

INSERT INTO schema_migrations (nom) VALUES ('migration-45-roles-lecture-seule.sql')
ON CONFLICT (nom) DO NOTHING;

-- Vérification : une seule policy, de commande SELECT (cmd = 'r') ; erp_app ne peut plus écrire (false / false / false) :
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'roles';
-- SELECT has_table_privilege('erp_app', 'public.roles', 'INSERT') AS insere,
--        has_table_privilege('erp_app', 'public.roles', 'UPDATE') AS modifie,
--        has_table_privilege('erp_app', 'public.roles', 'DELETE') AS supprime;

-- ==============================================================================
-- POLICIES ROW-LEVEL SECURITY — filet de sécurité supplémentaire au niveau base de données
-- ==============================================================================
-- Complète l'isolation applicative déjà en place (chaque requête filtre déjà par tenant_id) sans la
-- remplacer : si une route future oublie son WHERE tenant_id, ces policies bloquent quand même la
-- fuite au niveau PostgreSQL. N'a d'effet que si l'application se connecte avec un rôle non
-- propriétaire (voir provision-role.sql) — RLS est activé (enable-rls.sql) mais RLS + zéro policy
-- + rôle propriétaire = aucun changement de comportement.
--
-- Le contexte tenant est posé par attachTenantConnection (src/auth.js) via
-- `SELECT set_config('app.current_tenant_id', '<id>', false)` sur la connexion dédiée à chaque
-- requête HTTP authentifiée (et remis à '' juste avant de relâcher la connexion vers le pool).
--
-- Usage : coller ce fichier dans l'éditeur SQL Supabase, APRÈS provision-role.sql. Additif et
-- rejouable (CREATE OR REPLACE / DROP POLICY IF EXISTS avant chaque CREATE) : peut être ré-exécuté
-- sans risque si une policy doit être corrigée.
-- ==============================================================================

-- current_setting(..., true) renvoie NULL si jamais posé (missing_ok), mais renvoie '' (chaîne
-- vide) une fois que attachTenantConnection l'a remis à '' avant de relâcher la connexion — et
-- ''::int lève une erreur au lieu de s'évaluer proprement en NULL. NULLIF(..., '') ramène les deux
-- cas ("jamais posé" et "remis à zéro") au même NULL, pour un échec fermé propre plutôt qu'une 500.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS int LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::int
$$;

-- ------------------------------------------------------------------------------
-- Tables globales, partagées par toutes les organisations (pas de notion de tenant)
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS allow_all ON roles;
CREATE POLICY allow_all ON roles USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- organisations : policy sur `id` (c'est elle-même le tenant), pas sur `tenant_id`.
-- Lecture/écriture des lignes EXISTANTES restent strictes (rien ne les lit avant
-- l'authentification). L'INSERT est en revanche permissif : c'est la création d'une organisation
-- elle-même (inscription self-service, routes/inscription.js) qui n'a par définition aucun
-- contexte tenant à vérifier — on ne peut pas connaître l'id avant de l'avoir créé, et ajouter une
-- ligne neuve ne peut jamais exposer les données d'une organisation existante.
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON organisations;
DROP POLICY IF EXISTS tenant_isolation_select ON organisations;
DROP POLICY IF EXISTS tenant_isolation_insert ON organisations;
DROP POLICY IF EXISTS tenant_isolation_update ON organisations;
DROP POLICY IF EXISTS tenant_isolation_delete ON organisations;
CREATE POLICY tenant_isolation_select ON organisations FOR SELECT
    USING (id = current_tenant_id());
CREATE POLICY tenant_isolation_insert ON organisations FOR INSERT
    WITH CHECK (true);
CREATE POLICY tenant_isolation_update ON organisations FOR UPDATE
    USING (id = current_tenant_id())
    WITH CHECK (id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON organisations FOR DELETE
    USING (id = current_tenant_id());

-- ------------------------------------------------------------------------------
-- Tables avec tenant_id direct, échappatoire ciblée en lecture uniquement : consultées avant que le
-- tenant ne soit connu (login staff par email, login portail par téléphone, IPN PayDunya par
-- token — voir les commentaires "Lecture pré-tenant" dans auth.js/routes/portail.js/routes/finance.js).
-- Écriture toujours stricte : rien ne crée/modifie une ligne sans connaître son tenant.
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation_select ON utilisateurs;
DROP POLICY IF EXISTS tenant_isolation_insert ON utilisateurs;
DROP POLICY IF EXISTS tenant_isolation_update ON utilisateurs;
DROP POLICY IF EXISTS tenant_isolation_delete ON utilisateurs;
CREATE POLICY tenant_isolation_select ON utilisateurs FOR SELECT
    USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);
CREATE POLICY tenant_isolation_insert ON utilisateurs FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_update ON utilisateurs FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON utilisateurs FOR DELETE
    USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_select ON clients;
DROP POLICY IF EXISTS tenant_isolation_insert ON clients;
DROP POLICY IF EXISTS tenant_isolation_update ON clients;
DROP POLICY IF EXISTS tenant_isolation_delete ON clients;
CREATE POLICY tenant_isolation_select ON clients FOR SELECT
    USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);
CREATE POLICY tenant_isolation_insert ON clients FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_update ON clients FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON clients FOR DELETE
    USING (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_select ON paiements;
DROP POLICY IF EXISTS tenant_isolation_insert ON paiements;
DROP POLICY IF EXISTS tenant_isolation_update ON paiements;
DROP POLICY IF EXISTS tenant_isolation_delete ON paiements;
CREATE POLICY tenant_isolation_select ON paiements FOR SELECT
    USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL);
CREATE POLICY tenant_isolation_insert ON paiements FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_update ON paiements FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON paiements FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ------------------------------------------------------------------------------
-- Tables avec tenant_id direct, strictes (aucune échappatoire — jamais consultées avant
-- authentification) : zéro ligne visible si le contexte n'est pas posé, par conception.
-- ------------------------------------------------------------------------------

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'organisation_paydunya_config', 'abonnements', 'secteurs', 'lots_production', 'produits',
        'commandes', 'livraisons', 'factures', 'caisses_chauffeur', 'depenses', 'releves_bancaires',
        'fournisseurs', 'commandes_fournisseurs', 'tickets', 'audit_logs'
    ]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
            t
        );
    END LOOP;
END $$;

-- ------------------------------------------------------------------------------
-- Tables enfants sans tenant_id propre : filtrage par sous-requête vers le parent qui, lui, porte
-- tenant_id. Même filet strict, pas d'échappatoire (aucune de ces tables n'est lue pré-tenant).
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON releves_journaliers;
CREATE POLICY tenant_isolation ON releves_journaliers
    USING (EXISTS (SELECT 1 FROM lots_production lp WHERE lp.id = releves_journaliers.lot_id AND lp.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM lots_production lp WHERE lp.id = releves_journaliers.lot_id AND lp.tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_isolation ON stocks;
CREATE POLICY tenant_isolation ON stocks
    USING (EXISTS (SELECT 1 FROM produits p WHERE p.id = stocks.produit_id AND p.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM produits p WHERE p.id = stocks.produit_id AND p.tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_isolation ON lignes_commande;
CREATE POLICY tenant_isolation ON lignes_commande
    USING (EXISTS (SELECT 1 FROM commandes c WHERE c.id = lignes_commande.commande_id AND c.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM commandes c WHERE c.id = lignes_commande.commande_id AND c.tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_isolation ON lignes_commande_fournisseur;
CREATE POLICY tenant_isolation ON lignes_commande_fournisseur
    USING (EXISTS (SELECT 1 FROM commandes_fournisseurs cf WHERE cf.id = lignes_commande_fournisseur.commande_fournisseur_id AND cf.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM commandes_fournisseurs cf WHERE cf.id = lignes_commande_fournisseur.commande_fournisseur_id AND cf.tenant_id = current_tenant_id()));

DROP POLICY IF EXISTS tenant_isolation ON ticket_messages;
CREATE POLICY tenant_isolation ON ticket_messages
    USING (EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = ticket_messages.ticket_id AND tk.tenant_id = current_tenant_id()))
    WITH CHECK (EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = ticket_messages.ticket_id AND tk.tenant_id = current_tenant_id()));

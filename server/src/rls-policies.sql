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

-- Échappatoire cross-tenant pour la vue plateforme (routes/plateforme.js, réservée à un seul compte
-- support — voir migration-04-superviseur-plateforme.sql). Posé par requireSuperviseurPlateforme
-- (auth.js) UNIQUEMENT sur les routes qui en ont besoin, jamais par défaut.
-- CORRECTIF 2026-08-11 (audit sécurité) : contrairement à ce qu'affirmait ce commentaire, ce N'EST
-- PAS une échappatoire lecture seule — plusieurs policies WITH CHECK ci-dessous s'appuient dessus
-- (organisations, secteurs, audit_logs, organisation_abonnement_saas, factures_saas). Voir le
-- commentaire de requireSuperviseurPlateforme dans auth.js pour la liste exacte des écritures
-- autorisées.
CREATE OR REPLACE FUNCTION is_plateforme_admin() RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_plateforme_admin', true), ''), 'false')::boolean
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
-- "current_tenant_id() IS NULL" : même échappatoire pré-tenant que utilisateurs/clients ci-dessous —
-- /auth/login (routes/auth.js) fait maintenant JOIN organisations pour afficher le nom réel de la
-- ferme dans le topbar, sur une connexion pool brute où aucun contexte n'est encore posé. Sans cette
-- échappatoire, le JOIN renvoie zéro ligne pour TOUT LE MONDE et casse le login (piège déjà vécu deux
-- fois cette session avec RETURNING — celui-ci est un piège cousin, découvert avant déploiement cette
-- fois). Le nom d'une ferme n'est pas une donnée sensible (comparable à l'email/téléphone déjà lisible
-- pré-tenant), donc ce n'est pas une régression de confidentialité.
CREATE POLICY tenant_isolation_select ON organisations FOR SELECT
    USING (id = current_tenant_id() OR current_tenant_id() IS NULL OR is_plateforme_admin());
CREATE POLICY tenant_isolation_insert ON organisations FOR INSERT
    WITH CHECK (true);
CREATE POLICY tenant_isolation_update ON organisations FOR UPDATE
    USING (id = current_tenant_id() OR is_plateforme_admin())
    WITH CHECK (id = current_tenant_id() OR is_plateforme_admin());
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
    USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL OR is_plateforme_admin());
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
    USING (tenant_id = current_tenant_id() OR current_tenant_id() IS NULL OR is_plateforme_admin());
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
        'organisation_paydunya_config', 'organisation_whatsapp_config', 'abonnements', 'lots_production', 'produits',
        'commandes', 'livraisons', 'factures', 'caisses_chauffeur', 'depenses', 'releves_bancaires',
        'fournisseurs', 'commandes_fournisseurs'
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
-- secteurs : échappatoires de LECTURE et d'ÉCRITURE (INSERT uniquement) pour la vue plateforme —
-- jusqu'ici, un secteur ne pouvait être créé qu'à la création de la ferme (creerFerme.js) ; ceci
-- permet à Alioune d'ajouter un secteur à une ferme existante (ex: un client qui n'avait pris
-- qu'Avicole veut ajouter Piscicole), typiquement au moment de renégocier son abonnement SaaS. Lire
-- ET créer un secteur pour une AUTRE organisation reste réservé à is_plateforme_admin() ; modifier
-- ou supprimer un secteur existant reste strictement réservé au tenant lui-même — la vue plateforme
-- ne renomme/supprime jamais un secteur d'une autre ferme, seulement en ajouter un nouveau.
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON secteurs;
DROP POLICY IF EXISTS tenant_isolation_select ON secteurs;
DROP POLICY IF EXISTS tenant_isolation_insert ON secteurs;
DROP POLICY IF EXISTS tenant_isolation_update ON secteurs;
DROP POLICY IF EXISTS tenant_isolation_delete ON secteurs;
CREATE POLICY tenant_isolation_select ON secteurs FOR SELECT
    USING (tenant_id = current_tenant_id() OR is_plateforme_admin());
CREATE POLICY tenant_isolation_insert ON secteurs FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id() OR is_plateforme_admin());
CREATE POLICY tenant_isolation_update ON secteurs FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON secteurs FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ------------------------------------------------------------------------------
-- audit_logs : échappatoire d'ÉCRITURE — nécessaire pour que
-- /se-connecter-admin (routes/plateforme.js) puisse journaliser l'action DANS le journal
-- d'audit DE LA FERME CIBLE (pas celui du superviseur), pour que ça reste visible et compréhensible
-- si cette ferme consulte un jour son propre journal. Champ tenant_id fourni explicitement par le
-- code (jamais déduit du contexte de connexion), donc pas de risque qu'une écriture parte au hasard
-- vers le mauvais tenant. Lecture/mise à jour/suppression restent strictes comme toutes les autres.
--
-- Piège PostgreSQL à connaître si on touche à ceci : `INSERT ... RETURNING` exige EN PLUS que la
-- ligne insérée passe la policy SELECT (stricte, sans échappatoire, ici) — pas seulement le WITH
-- CHECK de l'INSERT. logAudit() (audit.js) n'utilise jamais RETURNING, précisément pour ça ; si un
-- jour un code l'ajoute pour cette table, l'insertion cross-tenant se remettra à échouer même si
-- cette policy a l'air correcte (vécu en vérifiant cette policy avec verify-rls.js).
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON audit_logs;
DROP POLICY IF EXISTS tenant_isolation_select ON audit_logs;
DROP POLICY IF EXISTS tenant_isolation_insert ON audit_logs;
DROP POLICY IF EXISTS tenant_isolation_update ON audit_logs;
DROP POLICY IF EXISTS tenant_isolation_delete ON audit_logs;
CREATE POLICY tenant_isolation_select ON audit_logs FOR SELECT
    USING (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_insert ON audit_logs FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id() OR is_plateforme_admin());
CREATE POLICY tenant_isolation_update ON audit_logs FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON audit_logs FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ------------------------------------------------------------------------------
-- tickets : échappatoire de LECTURE (contrairement à audit_logs ci-dessus, qui est en écriture),
-- pour la vue plateforme (routes/plateforme.js). Écriture (création de ticket, statut, etc.) reste
-- stricte : la vue plateforme ne peut jamais créer/modifier un ticket d'une autre organisation.
-- ------------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON tickets;
DROP POLICY IF EXISTS tenant_isolation_select ON tickets;
DROP POLICY IF EXISTS tenant_isolation_insert ON tickets;
DROP POLICY IF EXISTS tenant_isolation_update ON tickets;
DROP POLICY IF EXISTS tenant_isolation_delete ON tickets;
CREATE POLICY tenant_isolation_select ON tickets FOR SELECT
    USING (tenant_id = current_tenant_id() OR is_plateforme_admin());
CREATE POLICY tenant_isolation_insert ON tickets FOR INSERT
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_update ON tickets FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY tenant_isolation_delete ON tickets FOR DELETE
    USING (tenant_id = current_tenant_id());

-- ------------------------------------------------------------------------------
-- Tables enfants sans tenant_id propre : filtrage par sous-requête vers le parent qui, lui, porte
-- tenant_id. Même filet strict, pas d'échappatoire — SAUF ticket_messages en lecture, pour la même
-- raison que tickets ci-dessus (la vue plateforme doit pouvoir lire les échanges d'un ticket).
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
DROP POLICY IF EXISTS tenant_isolation_select ON ticket_messages;
DROP POLICY IF EXISTS tenant_isolation_write ON ticket_messages;
CREATE POLICY tenant_isolation_select ON ticket_messages FOR SELECT
    USING (
        EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = ticket_messages.ticket_id AND tk.tenant_id = current_tenant_id())
        OR is_plateforme_admin()
    );
CREATE POLICY tenant_isolation_write ON ticket_messages FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM tickets tk WHERE tk.id = ticket_messages.ticket_id AND tk.tenant_id = current_tenant_id()));

-- ------------------------------------------------------------------------------
-- Facturation SaaS (Massla facture les fermes, voir routes/plateforme.js) : contrairement à TOUTES
-- les autres tables de ce fichier, l'accès n'est JAMAIS basé sur current_tenant_id() — un admin de
-- ferme normal n'a aucune raison de voir ou modifier ces données, quelle que soit son organisation.
-- Seul is_plateforme_admin() ouvre l'accès, en lecture ET en écriture (contrairement aux
-- échappatoires ci-dessus, qui sont presque toutes lecture seule) : gérer un abonnement et générer
-- des factures SaaS EST l'objet même de cette table, pas un cas particulier à l'intérieur d'un accès
-- normalement tenant-scopé.
-- ------------------------------------------------------------------------------

-- Exception à la règle ci-dessus, en LECTURE SEULE : requireAuth (auth.js) doit pouvoir lire le
-- statut "actif" de l'abonnement DE SA PROPRE organisation à chaque requête, pour bloquer l'usage en
-- cas de non-paiement (voir le commentaire dans requireAuth). Ce n'est pas une fuite : une ferme voit
-- son propre statut d'abonnement, jamais celui d'une autre, et jamais les colonnes montant/frais
-- négociés d'une AUTRE organisation. Écriture reste strictement is_plateforme_admin() : une ferme ne
-- peut jamais modifier son propre abonnement.
DROP POLICY IF EXISTS plateforme_seulement ON organisation_abonnement_saas;
DROP POLICY IF EXISTS tenant_lecture_seule ON organisation_abonnement_saas;
DROP POLICY IF EXISTS plateforme_ecriture ON organisation_abonnement_saas;
DROP POLICY IF EXISTS plateforme_maj ON organisation_abonnement_saas;
DROP POLICY IF EXISTS plateforme_suppr ON organisation_abonnement_saas;
CREATE POLICY tenant_lecture_seule ON organisation_abonnement_saas FOR SELECT
    USING (tenant_id = current_tenant_id() OR is_plateforme_admin());
CREATE POLICY plateforme_ecriture ON organisation_abonnement_saas FOR INSERT
    WITH CHECK (is_plateforme_admin());
CREATE POLICY plateforme_maj ON organisation_abonnement_saas FOR UPDATE
    USING (is_plateforme_admin()) WITH CHECK (is_plateforme_admin());
CREATE POLICY plateforme_suppr ON organisation_abonnement_saas FOR DELETE
    USING (is_plateforme_admin());

DROP POLICY IF EXISTS plateforme_seulement ON factures_saas;
CREATE POLICY plateforme_seulement ON factures_saas
    USING (is_plateforme_admin())
    WITH CHECK (is_plateforme_admin());

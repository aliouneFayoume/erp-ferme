-- ==============================================================================
-- MIGRATION 32 — Policies RLS sur avis_publics (correctif : le formulaire « Laisser un avis » échouait)
-- ==============================================================================
-- Symptôme (2026-10-05) : tout visiteur qui envoyait un avis sur massla.sn/decouvrir recevait
-- « Erreur lors de l'enregistrement de votre avis. » (HTTP 500). Aucun avis n'a jamais été enregistré.
--
-- Cause : la migration 22 n'activait pas RLS sur avis_publics (« pas de RLS, comme roles »), mais Supabase l'a activé
-- automatiquement sur la table créée depuis l'éditeur SQL. RLS actif + zéro policy + rôle applicatif non propriétaire
-- (erp_app) = tout INSERT rejeté ; la lecture, elle, renvoyait silencieusement une liste vide. Le CI ne pouvait pas
-- le voir : enable-rls.sql ne listait pas cette table, donc elle n'avait jamais de RLS dans la base de vérification.
--
-- Correctif : policies explicites, réservées à erp_app (jamais PUBLIC : le rôle « anon » de l'API REST Supabase doit
-- rester sans accès, sinon n'importe qui pourrait publier un avis sans modération avec la clé publique du projet).
--   - INSERT   : uniquement un avis NON approuvé (la modération reste impossible à contourner, même par une erreur
--                de code future) ;
--   - SELECT   : lecture des avis publiés (GET /api/avis), recherche par jeton (lien d'approbation), vue Support ;
--   - UPDATE   : approbation (lien d'un clic ou vue Support plateforme) ;
--   - DELETE   : aucune policy, donc refusé — personne ne supprime d'avis depuis l'application.
--
-- 100% additif et rejouable : aucune donnée touchée (la table est vide).
ALTER TABLE avis_publics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS avis_depot_public ON avis_publics;
DROP POLICY IF EXISTS avis_lecture ON avis_publics;
DROP POLICY IF EXISTS avis_moderation ON avis_publics;

CREATE POLICY avis_depot_public ON avis_publics FOR INSERT TO erp_app
    WITH CHECK (approuve = FALSE);
CREATE POLICY avis_lecture ON avis_publics FOR SELECT TO erp_app
    USING (true);
CREATE POLICY avis_moderation ON avis_publics FOR UPDATE TO erp_app
    USING (true) WITH CHECK (true);

INSERT INTO schema_migrations (nom) VALUES ('migration-32-avis-publics-rls.sql')
ON CONFLICT (nom) DO NOTHING;

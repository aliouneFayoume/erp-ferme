-- ==============================================================================
-- MIGRATION 38 — Demandes du formulaire public « Essayer gratuitement / Demander ma démo »
-- ==============================================================================
-- Jusqu'ici le formulaire de massla.sn/decouvrir n'envoyait qu'un email : rien n'apparaissait dans l'application, et une
-- demande perdue dans une boîte mail était une demande perdue. Chaque demande est désormais enregistrée ici et listée dans
-- Support plateforme (à rappeler / traitée). Table globale SANS tenant_id (un visiteur n'a pas encore de ferme), comme
-- avis_publics (migration-32) : RLS actif avec des policies réservées à erp_app (jamais PUBLIC : la clé « anon » de l'API
-- REST Supabase doit rester sans accès). Pas de policy DELETE : refusé.
--
-- 100% additif et rejouable.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS demandes_contact (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    whatsapp VARCHAR(30) NOT NULL,
    preference VARCHAR(20),
    secteurs VARCHAR(100),
    nom_ferme VARCHAR(100),
    ville VARCHAR(50),
    source VARCHAR(10) NOT NULL DEFAULT 'demo',
    traitee BOOLEAN NOT NULL DEFAULT FALSE,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE demandes_contact ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS demandes_depot_public ON demandes_contact;
DROP POLICY IF EXISTS demandes_lecture ON demandes_contact;
DROP POLICY IF EXISTS demandes_traitement ON demandes_contact;

CREATE POLICY demandes_depot_public ON demandes_contact FOR INSERT TO erp_app
    WITH CHECK (traitee = FALSE);
CREATE POLICY demandes_lecture ON demandes_contact FOR SELECT TO erp_app
    USING (true);
CREATE POLICY demandes_traitement ON demandes_contact FOR UPDATE TO erp_app
    USING (true) WITH CHECK (true);

INSERT INTO schema_migrations (nom) VALUES ('migration-38-demandes-contact.sql')
ON CONFLICT (nom) DO NOTHING;

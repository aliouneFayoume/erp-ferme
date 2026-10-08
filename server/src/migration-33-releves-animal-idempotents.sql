-- ==============================================================================
-- MIGRATION 33 — Relevés d'animaux idempotents (saisie hors ligne de l'élevage sans doublon)
-- ==============================================================================
-- Les pesées, vaccinations, traitements et observations d'un animal peuvent désormais être saisis sans réseau : le
-- navigateur les garde puis les renvoie au retour de la connexion. Si l'enregistrement réussit mais que la réponse se
-- perd, le renvoi ne doit pas créer un second relevé (deux pesées identiques fausseraient la courbe de poids).
--
-- Même mécanisme que migration-30 (relevés de lots) : le navigateur crée UN identifiant par relevé (client_id) et le
-- conserve jusqu'au succès, y compris dans la file hors ligne ; le serveur ignore un relevé dont (animal, client_id)
-- existe déjà.
--
-- 100% additif : une colonne nullable + un index unique. Les relevés existants (client_id NULL) et ceux d'une ancienne
-- version de l'application (sans identifiant) restent acceptés comme avant — dans un index unique, les NULL ne se
-- comparent jamais entre eux. Aucune policy RLS à toucher (releves_animal est déjà filtrée via son animal).
--
-- À COLLER DANS SUPABASE AVANT LE PUSH : le code déployé écrit dans cette colonne.
-- ==============================================================================

ALTER TABLE releves_animal ADD COLUMN IF NOT EXISTS client_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_releves_animal_client ON releves_animal (animal_id, client_id);

INSERT INTO schema_migrations (nom) VALUES ('migration-33-releves-animal-idempotents.sql')
ON CONFLICT (nom) DO NOTHING;

-- ==============================================================================
-- MIGRATION 30 — Relevés journaliers idempotents (plus de doublons après un envoi rejoué)
-- ==============================================================================
-- Constat (2026-09-25) : POST /production/sync n'avait aucune protection contre le rejeu. Si l'enregistrement
-- réussissait mais que la réponse se perdait (coupure réseau sur le terrain), la file hors ligne rejouait le relevé,
-- ou l'utilisateur renvoyait le formulaire : mortalité, aliment et œufs étaient comptés DEUX fois.
--
-- Le navigateur donne désormais à chaque relevé un identifiant unique (client_id), créé UNE seule fois et conservé
-- jusqu'au succès, y compris dans la file hors ligne. Le serveur ignore un relevé dont (lot, client_id) existe déjà.
--
-- 100% additif : une colonne nullable + un index unique. Les relevés existants (client_id NULL) et ceux d'une
-- ancienne version de l'application (sans identifiant) restent acceptés comme avant — dans un index unique, les NULL
-- ne se comparent jamais entre eux. Aucune policy RLS à toucher (releves_journaliers est déjà filtrée via son lot).
-- ==============================================================================

ALTER TABLE releves_journaliers ADD COLUMN IF NOT EXISTS client_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_releves_lot_client ON releves_journaliers (lot_id, client_id);

INSERT INTO schema_migrations (nom) VALUES ('migration-30-releves-idempotents.sql')
ON CONFLICT (nom) DO NOTHING;

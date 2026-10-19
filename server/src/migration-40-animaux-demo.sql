-- ==============================================================================
-- MIGRATION 40 — Troupeau de démonstration d'un essai « Élevage » (animaux.est_demo)
-- ==============================================================================
-- L'essai gratuit propose maintenant l'élevage (bovins) en plus de l'aviculture, de la pisciculture et du maraîchage. Sa ferme
-- démo contient un petit troupeau d'exemple : ces animaux sont marqués est_demo pour s'afficher « Démo » et se supprimer en un
-- clic (« Supprimer la démo »), sans jamais toucher aux animaux réels de la ferme — même principe que lots_production.est_demo
-- (migration-35) et clients/produits/commandes.est_demo (migration-36).
--
-- 100% additif et rejouable : aucune ligne existante modifiée, aucune policy RLS à changer.
-- ==============================================================================

ALTER TABLE animaux ADD COLUMN IF NOT EXISTS est_demo BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations (nom) VALUES ('migration-40-animaux-demo.sql')
ON CONFLICT (nom) DO NOTHING;

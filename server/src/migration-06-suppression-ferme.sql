-- ==============================================================================
-- MIGRATION 06 — Soft delete des organisations (bouton "Supprimer" dans la vue plateforme)
-- ==============================================================================
-- 100% additif et rejouable : ajoute juste la colonne, ne touche à aucune ligne existante (NULL par
-- défaut = aucune ferme n'est marquée supprimée). Zéro impact sur le code déjà déployé tant que le
-- nouveau code (celui qui filtre WHERE deleted_at IS NULL et bloque l'accès dans requireAuth) n'est
-- pas déployé par-dessus.
-- ==============================================================================

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

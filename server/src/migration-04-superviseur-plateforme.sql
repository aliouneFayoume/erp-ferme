-- ==============================================================================
-- MIGRATION 04 — Colonne superviseur plateforme (support multi-fermes, routes/plateforme.js)
-- ==============================================================================
-- 100% additive et rejouable sans risque : une seule colonne, à FALSE par défaut pour tout le monde.
-- N'active AUCUN accès tant que (a) le nouveau code n'est pas déployé et (b) personne n'a le flag à
-- TRUE — ce fichier ne l'active pour aucun compte, voir l'étape manuelle séparée ci-dessous.
-- ==============================================================================

ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS est_superviseur_plateforme BOOLEAN NOT NULL DEFAULT FALSE;

-- Étape manuelle séparée (à exécuter une seule fois, pour le compte support d'Alioune uniquement) :
--   UPDATE utilisateurs SET est_superviseur_plateforme = TRUE WHERE email = '<son email de connexion>';
-- Volontairement pas automatisé ici : ce fichier doit rester rejouable sans jamais avoir à se
-- souvenir de retirer une activation avant de le relancer.

-- ==============================================================================
-- MIGRATION 11 — Révocation de session staff (audit sécurité 2026-08-11, E2)
-- ==============================================================================
-- Sans ceci, un JWT staff (12h) reste pleinement valide après un changement de mot de passe, une
-- désactivation, une suppression ou un changement de rôle — un employé licencié ou un poste volé
-- garde un accès complet jusqu'à expiration naturelle du token.
--
-- 100% additif et rejouable : DEFAULT 1 correspond à la valeur embarquée par tout token déjà émis
-- avant cette migration (voir le repli `?? 1` dans auth.js:signToken) — aucune session en cours
-- n'est invalidée par le déploiement de cette migration à elle seule.
-- ==============================================================================

ALTER TABLE utilisateurs ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1;

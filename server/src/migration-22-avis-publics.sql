-- ==============================================================================
-- MIGRATION 22 — Avis publics (site vitrine massla.sn/decouvrir)
-- ==============================================================================
-- 100% additif, nouvelle table isolée. Délibérément SANS tenant_id : un avis ne concerne aucune
-- ferme cliente précise, c'est un visiteur du site vitrine qui commente son expérience. Pas de RLS
-- ici, comme `roles` — donnée globale à la plateforme, pas au tenant (voir schema.sql).

-- token_approbation_hash : approbation en un clic depuis l'email de notification (routes/avis.js),
-- même pattern que utilisateurs.email_verification_token_hash (email.js/auth.js) — jeton en clair
-- envoyé par email, seul son hash SHA-256 est stocké ; effacé après usage (lien à usage unique).
CREATE TABLE IF NOT EXISTS avis_publics (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    nom_ferme VARCHAR(100),
    note SMALLINT NOT NULL CHECK (note BETWEEN 1 AND 5),
    commentaire VARCHAR(600) NOT NULL,
    approuve BOOLEAN NOT NULL DEFAULT FALSE,
    token_approbation_hash VARCHAR(64),
    token_approbation_expire_le TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO schema_migrations (nom) VALUES ('migration-22-avis-publics.sql')
ON CONFLICT (nom) DO NOTHING;

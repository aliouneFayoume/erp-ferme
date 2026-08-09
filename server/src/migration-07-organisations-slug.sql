-- ==============================================================================
-- MIGRATION 07 — Sous-domaines par ferme (image de marque avant connexion)
-- ==============================================================================
-- 100% additif et rejouable : ajoute la colonne (no-op si déjà présente), puis ne backfille que les
-- lignes qui n'ont pas encore de slug. Zéro impact sur le code déjà déployé tant que le nouveau code
-- (routes/public.js, qui seul lit cette colonne) n'est pas déployé par-dessus.
-- ==============================================================================

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS slug VARCHAR(63) UNIQUE;

DO $$
DECLARE
    org RECORD;
    slug_base TEXT;
    candidat TEXT;
    suffixe INT;
BEGIN
    FOR org IN SELECT id, nom FROM organisations WHERE slug IS NULL ORDER BY id LOOP
        slug_base := lower(regexp_replace(org.nom, '[^a-zA-Z0-9]+', '-', 'g'));
        slug_base := trim(both '-' from slug_base);
        IF slug_base = '' THEN
            slug_base := 'ferme';
        END IF;
        slug_base := left(slug_base, 50);

        candidat := slug_base;
        suffixe := 2;
        WHILE EXISTS (SELECT 1 FROM organisations WHERE slug = candidat) LOOP
            candidat := slug_base || '-' || suffixe;
            suffixe := suffixe + 1;
        END LOOP;

        UPDATE organisations SET slug = candidat WHERE id = org.id;
    END LOOP;
END $$;

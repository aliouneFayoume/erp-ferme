-- ==============================================================================
-- MIGRATION 02 — Corrige lignes_commande_fournisseur : intrants, pas catalogue de vente
-- ==============================================================================
-- migration-01-fournisseurs.sql liait à tort les lignes de commande fournisseur au catalogue
-- `produits` (les produits VENDUS aux clients, avec tarifs B2B/B2C) et créditait `stocks` à la
-- réception. Une commande fournisseur porte en réalité sur des intrants achetés (aliment bétail,
-- vaccins, semences, matériel...), sans rapport avec ce catalogue — d'où le remplacement de la FK
-- produit_id par une désignation en texte libre, et l'abandon du crédit de stock à la réception
-- (seule la dépense reste générée).
--
-- Sûr à exécuter : aucune commande fournisseur n'a encore été enregistrée en production au moment
-- d'écrire cette migration (vérifié : commandes_fournisseurs et lignes_commande_fournisseur vides).
-- Écrite en IF EXISTS/IF NOT EXISTS pour rester rejouable sans risque au cas où.
--
-- À exécuter UNE FOIS contre la base de production, avant de déployer le code correspondant.
-- ==============================================================================

ALTER TABLE lignes_commande_fournisseur DROP COLUMN IF EXISTS produit_id;
ALTER TABLE lignes_commande_fournisseur ADD COLUMN IF NOT EXISTS designation VARCHAR(150) NOT NULL DEFAULT '';
ALTER TABLE lignes_commande_fournisseur ALTER COLUMN designation DROP DEFAULT;
ALTER TABLE lignes_commande_fournisseur ADD COLUMN IF NOT EXISTS unite VARCHAR(30);

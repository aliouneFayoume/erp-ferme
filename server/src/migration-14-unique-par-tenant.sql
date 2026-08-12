-- ==============================================================================
-- MIGRATION 14 — Contraintes UNIQUE par tenant (audit sécurité 2026-08-11, M3)
-- ==============================================================================
-- Ces contraintes étaient globales, pas par tenant. Conséquences en production :
-- - lots_production.code_lot : la ferme A qui crée le lot "A-45" empêchait DÉFINITIVEMENT la
--   ferme B de créer un lot du même code, sans raison métier.
-- - commandes.numero_commande / commandes_fournisseurs.numero_commande : combiné à l'ancien
--   générateur (CMD-${Date.now().toString().slice(-6)}, corrigé le même jour dans numero.js), deux
--   commandes créées à ~16,7 minutes d'intervalle DANS N'IMPORTE QUELLE ferme pouvaient entrer en
--   collision → violation d'unicité → 500 en pleine prise de commande.
--
-- Passer d'une contrainte UNIQUE(colonne) à UNIQUE(tenant_id, colonne) est strictement moins
-- restrictif : toute donnée valide sous l'ancienne contrainte reste valide sous la nouvelle, cette
-- migration ne peut donc pas échouer sur des données existantes. Noms de contraintes vérifiés
-- contre la production avant d'écrire cette migration (convention de nommage par défaut
-- PostgreSQL : <table>_<colonne>_key).
-- ==============================================================================

ALTER TABLE lots_production DROP CONSTRAINT IF EXISTS lots_production_code_lot_key;
ALTER TABLE lots_production ADD CONSTRAINT lots_production_tenant_code_lot_key UNIQUE (tenant_id, code_lot);

ALTER TABLE commandes DROP CONSTRAINT IF EXISTS commandes_numero_commande_key;
ALTER TABLE commandes ADD CONSTRAINT commandes_tenant_numero_key UNIQUE (tenant_id, numero_commande);

ALTER TABLE commandes_fournisseurs DROP CONSTRAINT IF EXISTS commandes_fournisseurs_numero_commande_key;
ALTER TABLE commandes_fournisseurs ADD CONSTRAINT commandes_fournisseurs_tenant_numero_key UNIQUE (tenant_id, numero_commande);

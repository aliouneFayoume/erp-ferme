-- ==============================================================================
-- ACTIVATION DE ROW-LEVEL SECURITY (RLS) SUR TOUTES LES TABLES PUBLIQUES
-- ==============================================================================
-- Pourquoi un fichier séparé de schema.sql : pg-mem (utilisé en dev local et dans
-- toute la suite de tests, voir src/db.js) ne sait pas parser
-- "ENABLE ROW LEVEL SECURITY" — l'inclure dans schema.sql casserait `npm start`
-- sans DATABASE_URL et l'intégralité de `npm test`. Ce fichier n'est donc chargé
-- que manuellement (ou via un script one-off) contre la vraie base PostgreSQL
-- (Supabase / VPS), jamais par db.js ni testApp.js.
--
-- Effet : l'API REST publique de Supabase (PostgREST, accessible avec la clé
-- "anon" du projet) n'a accès à AUCUNE table tant qu'aucune policy n'est créée
-- (RLS activé + zéro policy = accès refusé par défaut pour tout rôle non
-- propriétaire). Le backend Express de cet ERP se connecte en direct via
-- DATABASE_URL avec le rôle "postgres" (propriétaire des tables), qui contourne
-- RLS par défaut — aucun changement de comportement pour l'application.
-- Cet ERP n'utilise jamais l'API REST/anon de Supabase : le refus total est
-- le comportement voulu, pas une étape intermédiaire vers des policies fines.
-- ==============================================================================

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilisateurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE abonnements ENABLE ROW LEVEL SECURITY;
ALTER TABLE secteurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lots_production ENABLE ROW LEVEL SECURITY;
ALTER TABLE releves_journaliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE produits ENABLE ROW LEVEL SECURITY;
ALTER TABLE stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE commandes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lignes_commande ENABLE ROW LEVEL SECURITY;
ALTER TABLE livraisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE factures ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiements ENABLE ROW LEVEL SECURITY;
ALTER TABLE caisses_chauffeur ENABLE ROW LEVEL SECURITY;
ALTER TABLE depenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE releves_bancaires ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commandes_fournisseurs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lignes_commande_fournisseur ENABLE ROW LEVEL SECURITY;

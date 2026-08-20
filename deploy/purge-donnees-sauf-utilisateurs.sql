-- ==============================================================================
-- PURGE DES DONNÉES DE PRODUCTION — TOUT SAUF UTILISATEURS
-- ==============================================================================
-- À exécuter avec le rôle PROPRIÉTAIRE (postgres) dans l'éditeur SQL Supabase,
-- JAMAIS avec le rôle applicatif erp_app (pas les privilèges, et RLS s'appliquerait).
--
-- ⚠️ IRRÉVERSIBLE. Faire un backup complet AVANT (voir instructions ci-dessous),
-- vérifier qu'il est bien téléchargé, PUIS lancer ce script.
--
-- Conserve intactes : utilisateurs, roles, organisations, organisation_paydunya_config
-- (comptes staff + structure tenant Massla + config PayDunya).
-- Vide toutes les données métier (clients, commandes, factures, paiements, stocks,
-- production, fournisseurs, tickets, comptabilité, audit) et réinitialise les
-- compteurs SERIAL (RESTART IDENTITY) pour repartir sur des IDs propres à 1.
-- CASCADE gère automatiquement l'ordre des clés étrangères entre ces tables.
-- ==============================================================================

TRUNCATE TABLE
    audit_logs,
    ticket_messages,
    tickets,
    lignes_commande_fournisseur,
    commandes_fournisseurs,
    fournisseurs,
    releves_bancaires,
    depenses,
    caisses_chauffeur,
    paiements,
    factures,
    livraisons,
    lignes_commande,
    commandes,
    stocks,
    produits,
    releves_journaliers,
    lots_production,
    secteurs,
    abonnements,
    clients
RESTART IDENTITY CASCADE;

-- Vérification rapide après coup (doit renvoyer 0 pour toutes ces tables) :
-- SELECT 'clients', count(*) FROM clients
-- UNION ALL SELECT 'commandes', count(*) FROM commandes
-- UNION ALL SELECT 'paiements', count(*) FROM paiements
-- UNION ALL SELECT 'utilisateurs (doit être > 0)', count(*) FROM utilisateurs;

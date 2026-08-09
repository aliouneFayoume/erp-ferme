-- ==============================================================================
-- MIGRATION 05 — Facturation SaaS (Massla facture les fermes clientes)
-- ==============================================================================
-- 100% additive et rejouable sans risque : deux nouvelles tables, aucune colonne touchée sur
-- l'existant. N'a aucun effet tant que le nouveau code (routes/plateforme.js étendu) n'est pas
-- déployé par-dessus, et même après déploiement, ces tables restent vides tant que personne ne
-- configure un abonnement pour une organisation depuis la vue plateforme.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS organisation_abonnement_saas (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    modules_actifs TEXT[] NOT NULL DEFAULT '{}',
    montant_mensuel INT NOT NULL,
    frais_configuration INT,
    frais_configuration_facture BOOLEAN NOT NULL DEFAULT FALSE,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS factures_saas (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    type VARCHAR(20) CHECK (type IN ('CONFIGURATION', 'ABONNEMENT')) NOT NULL,
    periode VARCHAR(7),
    montant INT NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('A_PAYER', 'PAYEE', 'EN_RETARD', 'ANNULEE')) NOT NULL DEFAULT 'A_PAYER',
    date_echeance DATE NOT NULL,
    date_paiement TIMESTAMP,
    methode_paiement VARCHAR(30),
    notes TEXT,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

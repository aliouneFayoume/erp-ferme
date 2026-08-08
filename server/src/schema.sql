-- ==============================================================================
-- ERP FERME INTÉGRÉE "MASSLA" - SCHEMA DE BASE DE DONNÉES (PostgreSQL)
-- Base fournie par le client, étendue pour couvrir le cahier des charges :
--   - Soft delete (deleted_at) + journal d'audit
--   - Double pool de stock B2B / B2C
--   - Relevés production étendus (pH, température, biométrie, récolte)
--   - Caisse chauffeur virtuelle
--   - Abonnements B2C (paniers récurrents)
-- ==============================================================================

-- --------------------------------------------------------
-- 0. ORGANISATIONS (PROTOTYPE MULTI-TENANT)
-- --------------------------------------------------------
-- Prototype d'isolement multi-organisations (cf. plan multi-tenant) : chaque organisation est une
-- ferme cliente distincte. roles/permissions restent globaux (pas propres à une organisation) ;
-- tout le reste des données métier (utilisateurs, clients, secteurs, produits, commandes, lots,
-- caisses chauffeur) est rattaché à une organisation via tenant_id.

CREATE TABLE organisations (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(100) NOT NULL,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 1. UTILISATEURS & SÉCURITÉ (RBAC)
-- --------------------------------------------------------

CREATE TABLE roles (
    id SERIAL PRIMARY KEY,
    nom VARCHAR(50) UNIQUE NOT NULL -- 'admin', 'comptable', 'chef_prod', 'livreur'
);

CREATE TABLE utilisateurs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    nom_complet VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL, -- reste global pour ce prototype (voir plan : résolution de tenant à la connexion non traitée ici)
    mot_de_passe_hash VARCHAR(255) NOT NULL,
    role_id INT REFERENCES roles(id),
    secteur_id INT, -- pour un chef de prod : secteur unique auquel il a accès
    actif BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Chaque organisation est son propre agrégateur de paiement PayDunya (ses propres identifiants,
-- son propre compte marchand) — Massla n'est qu'une organisation comme une autre de ce point de
-- vue, avec ses identifiants migrés depuis les variables d'environnement historiques. Une ligne
-- par organisation ; absente tant que l'admin de cette organisation n'a pas renseigné ses clés
-- (voir routes/parametres-paiement.js). Les 4 identifiants sont chiffrés au repos (credentials.js) :
-- jamais lisibles en clair dans un dump ou un accès direct à la base.
CREATE TABLE organisation_paydunya_config (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    mode VARCHAR(10) CHECK (mode IN ('test', 'live')) NOT NULL DEFAULT 'test',
    master_key_chiffre TEXT NOT NULL,
    private_key_chiffre TEXT NOT NULL,
    public_key_chiffre TEXT NOT NULL,
    token_chiffre TEXT NOT NULL,
    mis_a_jour_par INT REFERENCES utilisateurs(id),
    mis_a_jour_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 2. CRM & CLIENTS (B2B / B2C)
-- --------------------------------------------------------

CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    nom VARCHAR(100) NOT NULL,
    type_client VARCHAR(10) CHECK (type_client IN ('B2B', 'B2C')),
    categorie_tarifaire VARCHAR(20) DEFAULT 'standard', -- 'standard', 'grossiste', 'restaurant'
    telephone VARCHAR(20) UNIQUE NOT NULL,
    adresse TEXT,
    gps_lat NUMERIC, -- Pour la carte du livreur
    gps_lng NUMERIC, -- Pour la carte du livreur
    limite_credit NUMERIC DEFAULT 0.00, -- Limite d'encours pour B2B
    solde_encours NUMERIC DEFAULT 0.00, -- Dette actuelle (pour le Dashboard)
    est_abonne BOOLEAN DEFAULT FALSE, -- Pour les paniers B2C récurrents
    pin_hash VARCHAR(255), -- Code d'accès au portail client (haché comme un mot de passe), NULL tant qu'aucun n'a été généré
    pin_version INT NOT NULL DEFAULT 1, -- Incrémenté à chaque régénération du PIN : invalide immédiatement les sessions portail déjà émises
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE abonnements (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    client_id INT REFERENCES clients(id),
    produit_id INT, -- FK ajoutée après création de produits
    quantite INT NOT NULL DEFAULT 1,
    frequence VARCHAR(20) CHECK (frequence IN ('HEBDOMADAIRE', 'BIMENSUEL', 'MENSUEL')) DEFAULT 'HEBDOMADAIRE',
    jour_livraison VARCHAR(10), -- 'LUNDI', 'MARDI', ...
    actif BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 3. PRODUCTION & PWA (Offline-First)
-- --------------------------------------------------------

CREATE TABLE secteurs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    nom VARCHAR(50) NOT NULL, -- libre par organisation (prototype) : plus limité à 'Avicole'/'Piscicole'/'Maraîcher'
    suivi_recolte BOOLEAN DEFAULT FALSE -- coché pour un secteur de type culture (maturité/récolte à suivre), ex-"Maraîcher"
);

CREATE TABLE lots_production (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    code_lot VARCHAR(50) UNIQUE NOT NULL, -- ex: 'A-45'
    quantite_initiale INT NOT NULL,
    date_demarrage DATE NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('EN_COURS', 'ABATTAGE', 'TERMINE', 'PERDU')),
    culture VARCHAR(100), -- Maraîcher : type de culture (tomate, chou, ...) — planification des cultures
    duree_maturite_jours INT, -- Maraîcher : durée avant récolte prévue, en jours depuis date_demarrage
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP
);

CREATE TABLE releves_journaliers (
    id SERIAL PRIMARY KEY,
    lot_id INT REFERENCES lots_production(id),
    utilisateur_id INT REFERENCES utilisateurs(id),
    date_releve DATE NOT NULL,
    mortalite INT DEFAULT 0,
    conso_aliment_kg NUMERIC DEFAULT 0.00,
    poids_moyen_g NUMERIC DEFAULT 0.00, -- biométrie (poids moyen échantillonné)
    taille_moyenne_cm NUMERIC, -- Piscicole : biométrie (taille moyenne échantillonnée)
    temperature_eau NUMERIC, -- Piscicole : qualité de l'eau
    ph_eau NUMERIC, -- Piscicole : qualité de l'eau
    intrants_utilises TEXT, -- Maraîcher : semences/engrais/phytosanitaires
    quantite_recoltee_kg NUMERIC, -- Maraîcher : récolte du jour
    notes TEXT,
    est_synchronise BOOLEAN DEFAULT TRUE, -- Essentiel pour la PWA (gestion offline)
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 4. CATALOGUE & INVENTAIRE
-- --------------------------------------------------------

CREATE TABLE produits (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    nom VARCHAR(100) NOT NULL,
    unite_mesure VARCHAR(20) CHECK (unite_mesure IN ('TETE', 'KG', 'CAISSE', 'BOTTES')),
    prix_unitaire_b2b NUMERIC NOT NULL, -- Tarif "restaurant" (B2B standard)
    prix_unitaire_b2c NUMERIC NOT NULL, -- Tarif "standard" (particuliers)
    prix_unitaire_grossiste NUMERIC, -- Tarif préférentiel gros volumes (catégorie B2B "grossiste") ; NULL = retombe sur le tarif B2B standard
    actif BOOLEAN DEFAULT TRUE,
    deleted_at TIMESTAMP
);

ALTER TABLE abonnements ADD CONSTRAINT fk_abonnement_produit FOREIGN KEY (produit_id) REFERENCES produits(id);

CREATE TABLE stocks (
    id SERIAL PRIMARY KEY,
    produit_id INT REFERENCES produits(id) UNIQUE,
    quantite_disponible INT NOT NULL DEFAULT 0, -- pool total non réservé
    quantite_reservee_b2b INT NOT NULL DEFAULT 0, -- Double pool d'inventaire : réservé pros
    quantite_reservee_b2c INT NOT NULL DEFAULT 0, -- Double pool d'inventaire : réservé particuliers
    seuil_alerte INT DEFAULT 10,
    derniere_mise_a_jour TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 5. VENTES, COMMANDES & LOGISTIQUE
-- --------------------------------------------------------

CREATE TABLE commandes (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    numero_commande VARCHAR(20) UNIQUE NOT NULL, -- ex: 'CMD-8492'
    client_id INT REFERENCES clients(id),
    statut VARCHAR(20) CHECK (statut IN ('EN_ATTENTE', 'PREPAREE', 'EN_LIVRAISON', 'LIVREE', 'ANNULEE')),
    montant_total NUMERIC NOT NULL,
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lignes_commande (
    id SERIAL PRIMARY KEY,
    commande_id INT REFERENCES commandes(id) ON DELETE CASCADE,
    produit_id INT REFERENCES produits(id),
    quantite INT NOT NULL,
    prix_unitaire_applique NUMERIC NOT NULL, -- Fige le prix au moment de l'achat
    sous_total NUMERIC NOT NULL
);

CREATE TABLE livraisons (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    commande_id INT REFERENCES commandes(id),
    livreur_id INT REFERENCES utilisateurs(id),
    date_prevue DATE NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('A_FAIRE', 'EN_COURS', 'TERMINEE', 'ECHOUEE')),
    notes_livreur TEXT,
    preuve_livraison TEXT, -- signature/photo (texte/URL en simulation)
    mise_a_jour_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 6. FINANCE & PAIEMENTS (API Mobile Money)
-- --------------------------------------------------------

CREATE TABLE factures (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    commande_id INT REFERENCES commandes(id),
    date_echeance DATE NOT NULL, -- Pour la gestion des encours à 30 jours (B2B)
    statut VARCHAR(20) CHECK (statut IN ('A_PAYER', 'PAYEE_PARTIEL', 'PAYEE', 'EN_RETARD')),
    montant_restant NUMERIC NOT NULL
);

CREATE TABLE paiements (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    commande_id INT REFERENCES commandes(id),
    client_id INT REFERENCES clients(id),
    montant NUMERIC NOT NULL,
    methode_paiement VARCHAR(20) CHECK (methode_paiement IN ('WAVE', 'ORANGE_MONEY', 'ESPECES', 'VIREMENT')),
    reference_transaction VARCHAR(100), -- ID de transaction renvoyé par le Webhook de l'API
    statut VARCHAR(20) CHECK (statut IN ('EN_ATTENTE', 'VALIDE', 'ECHOUE')),
    livreur_id INT REFERENCES utilisateurs(id), -- encaissement terrain (caisse chauffeur)
    date_paiement TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Caisse Chauffeur Virtuelle : ouverture/clôture journalière par livreur
CREATE TABLE caisses_chauffeur (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    livreur_id INT REFERENCES utilisateurs(id),
    date_caisse DATE NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('OUVERTE', 'CLOTUREE')) DEFAULT 'OUVERTE',
    montant_theorique NUMERIC DEFAULT 0.00, -- somme des encaissements applicatifs du jour
    montant_depose NUMERIC, -- déclaré par le comptable à la clôture
    ecart NUMERIC,
    valide_par INT REFERENCES utilisateurs(id),
    notes TEXT,
    ouverte_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    cloturee_le TIMESTAMP,
    UNIQUE (livreur_id, date_caisse)
);

-- --------------------------------------------------------
-- 7. COMPTABILITÉ ANALYTIQUE & RAPPROCHEMENT BANCAIRE
-- --------------------------------------------------------

-- Dépenses par pôle (aliment, intrants, main d'œuvre, ...) : permet de calculer la marge par secteur.
CREATE TABLE depenses (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id), -- NULL = dépense générale (non rattachée à un pôle)
    categorie VARCHAR(50) NOT NULL, -- 'Aliment', 'Intrants', 'Main d''œuvre', 'Vétérinaire', 'Logistique', 'Autre'
    montant NUMERIC NOT NULL,
    description TEXT,
    date_depense DATE NOT NULL,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Relevés bancaires (saisie manuelle simulant un import) et rapprochement avec les paiements.
CREATE TABLE releves_bancaires (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    date_operation DATE NOT NULL,
    libelle TEXT NOT NULL,
    montant NUMERIC NOT NULL,
    type_operation VARCHAR(10) CHECK (type_operation IN ('CREDIT', 'DEBIT')) NOT NULL,
    paiement_id INT REFERENCES paiements(id), -- lien vers le paiement applicatif correspondant une fois rapproché
    rapproche BOOLEAN DEFAULT FALSE,
    rapproche_par INT REFERENCES utilisateurs(id),
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 7bis. APPROVISIONNEMENT (fournisseurs & commandes d'achat)
-- --------------------------------------------------------
-- Miroir côté achats du couple commandes/lignes_commande (côté ventes) pour le numéro/statut/soft
-- delete, mais porte sur des intrants achetés (aliment bétail, vaccins, semences, matériel...), pas
-- sur le catalogue `produits` (les produits VENDUS aux clients, avec tarifs B2B/B2C) : une commande
-- fournisseur ne doit donc pas référencer `produits` ni créditer `stocks`, d'où la désignation en
-- texte libre plutôt qu'une FK. Le seuil de réapprovisionnement réutilise stocks.seuil_alerte (déjà
-- utilisé pour le badge stock bas du Catalogue) comme simple signal pour l'équipe, sans lien
-- automatique avec les commandes fournisseurs.

CREATE TABLE fournisseurs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    nom VARCHAR(150) NOT NULL,
    categorie VARCHAR(50), -- 'Aliment', 'Intrants', 'Vétérinaire', 'Matériel', 'Autre'
    telephone VARCHAR(30),
    email VARCHAR(150),
    adresse TEXT,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE commandes_fournisseurs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    numero_commande VARCHAR(20) UNIQUE NOT NULL, -- ex: 'CMF-8492'
    fournisseur_id INT REFERENCES fournisseurs(id),
    statut VARCHAR(20) CHECK (statut IN ('COMMANDEE', 'RECUE', 'ANNULEE')) DEFAULT 'COMMANDEE',
    date_commande DATE NOT NULL DEFAULT CURRENT_DATE,
    date_livraison_prevue DATE,
    date_livraison_reelle DATE, -- renseignée à la réception : base du suivi des délais fournisseur
    montant_total NUMERIC NOT NULL DEFAULT 0,
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE lignes_commande_fournisseur (
    id SERIAL PRIMARY KEY,
    commande_fournisseur_id INT REFERENCES commandes_fournisseurs(id) ON DELETE CASCADE,
    designation VARCHAR(150) NOT NULL, -- article acheté en texte libre (ex: "Aliment ponte 25kg"), pas un produit du catalogue de vente
    unite VARCHAR(30),
    quantite NUMERIC NOT NULL,
    prix_unitaire NUMERIC NOT NULL,
    sous_total NUMERIC NOT NULL
);

CREATE INDEX idx_commandes_fournisseurs_statut ON commandes_fournisseurs(statut);

-- --------------------------------------------------------
-- 8. SUPPORT CLIENT (SAV)
-- --------------------------------------------------------

CREATE TABLE tickets (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    client_id INT REFERENCES clients(id),
    sujet VARCHAR(150) NOT NULL,
    description TEXT,
    priorite VARCHAR(10) CHECK (priorite IN ('BASSE', 'NORMALE', 'HAUTE', 'URGENTE')) DEFAULT 'NORMALE',
    statut VARCHAR(20) CHECK (statut IN ('OUVERT', 'EN_COURS', 'RESOLU', 'FERME')) DEFAULT 'OUVERT',
    assigne_a INT REFERENCES utilisateurs(id),
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    mis_a_jour_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Fil d'échanges d'un ticket (notes internes + suivi des réponses au client).
-- Auteur d'un message : soit un membre du staff (utilisateur_id), soit le client lui-même via le
-- portail (auteur_client_id) — exactement un des deux est renseigné.
CREATE TABLE ticket_messages (
    id SERIAL PRIMARY KEY,
    ticket_id INT REFERENCES tickets(id) ON DELETE CASCADE,
    utilisateur_id INT REFERENCES utilisateurs(id),
    auteur_client_id INT REFERENCES clients(id),
    message TEXT NOT NULL,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 9. JOURNAL D'AUDIT (traçabilité obligatoire)
-- --------------------------------------------------------

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    table_name VARCHAR(50) NOT NULL,
    row_id INT,
    action VARCHAR(20) NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'LOGIN'
    utilisateur_id INT REFERENCES utilisateurs(id),
    details JSONB,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- INDEX POUR OPTIMISER LES PERFORMANCES DES REQUÊTES DU DASHBOARD
-- ==============================================================================
CREATE INDEX idx_commandes_statut ON commandes(statut);
CREATE INDEX idx_releves_lot_date ON releves_journaliers(lot_id, date_releve);
CREATE INDEX idx_clients_type ON clients(type_client);
CREATE INDEX idx_paiements_statut ON paiements(statut);
CREATE INDEX idx_audit_table_row ON audit_logs(table_name, row_id);
CREATE INDEX idx_tickets_statut ON tickets(statut);

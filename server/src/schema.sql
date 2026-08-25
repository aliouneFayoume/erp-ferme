-- ==============================================================================
-- ERP FERME INTÉGRÉE "MASSLA" - SCHEMA DE BASE DE DONNÉES (PostgreSQL)
-- Base fournie par le client, étendue pour couvrir le cahier des charges :
--   - Soft delete (deleted_at) + journal d'audit
--   - Double pool de stock B2B / B2C
--   - Relevés production étendus (pH, température, biométrie, récolte)
--   - Caisse chauffeur virtuelle
--   - Abonnements B2C (paniers récurrents)
-- ==============================================================================

-- Registre des migrations SQL appliquées (audit systèmes/développement 2026-08-11) — voir
-- migration-15-registre-migrations.sql pour le contexte complet et le modèle à suivre pour toute
-- nouvelle migration. Présente ici pour que toute base créée à partir de ce schéma (fraîche, tests)
-- l'ait dès le départ, sans dépendre de l'exécution manuelle de la migration 15.
CREATE TABLE schema_migrations (
    nom TEXT PRIMARY KEY,
    appliquee_le TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    -- Sous-domaine (<slug>.massla.sn) utilisé UNIQUEMENT pour l'image de marque avant connexion
    -- (routes/public.js) : la ferme racine massla.sn continue de servir Massla par défaut, sans
    -- changer la logique de connexion elle-même (email reste global, voir utilisateurs.email).
    -- Nullable : les fixtures de test (verify-rls.js) n'en ont pas besoin ; toute vraie ferme créée
    -- via creerFerme.js en reçoit toujours un.
    slug VARCHAR(63) UNIQUE,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Soft delete : une ferme qui n'est plus cliente disparaît de la vue plateforme (voir
    -- routes/plateforme.js) et son accès est bloqué (requireAuth, auth.js), mais ses données
    -- restent intactes — jamais de suppression physique, même logique qu'ailleurs dans ce schéma.
    deleted_at TIMESTAMP,
    -- Identifie l'organisation de la plateforme elle-même (Ferme Massla) — jamais une seconde
    -- organisation. Sert à décider quels identifiants WhatsApp utiliser pour les relances de
    -- facturation client (routes/finance.js) : Massla utilise les identifiants globaux
    -- (WHATSAPP_ACCESS_TOKEN, server/.env), toute autre ferme doit configurer les siens
    -- (organisation_whatsapp_config, réglages self-service) — voir la demande explicite de
    -- l'utilisateur de ne pas partager le numéro WhatsApp de Massla avec les autres clients.
    est_plateforme BOOLEAN NOT NULL DEFAULT FALSE,
    -- Dépôt GPS (optimisation de tournée, routing.js) et en-tête de facture PDF (facturePdf.js) —
    -- audit systèmes 2026-08-11 (item #13). Nullables : une ferme sans coordonnées renseignées se
    -- replie sur le dépôt par défaut de routing.js (routes/logistique.js) plutôt que d'échouer ;
    -- une facture sans adresse/téléphone omet simplement ces lignes plutôt que d'afficher "null".
    gps_lat NUMERIC,
    gps_lng NUMERIC,
    adresse VARCHAR(255),
    telephone VARCHAR(20)
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
    -- Vue plateforme (routes/plateforme.js) : accès en lecture à toutes les organisations, réservé
    -- à Alioune (support/vente multi-fermes) — sans rapport avec le rôle 'admin', qui reste
    -- scopé à sa propre organisation comme pour tout le monde. Activé manuellement en base pour un
    -- seul compte, jamais via l'inscription self-service ni l'API.
    est_superviseur_plateforme BOOLEAN NOT NULL DEFAULT FALSE,
    -- Révocation de session (auth.js:requireAuth) : incrémenté à chaque changement de mot de passe,
    -- désactivation, suppression, ou changement de rôle/secteur. Un JWT embarque cette valeur au
    -- moment de sa signature (signToken) ; si elle ne correspond plus à celle en base, le token est
    -- rejeté même s'il n'a pas encore expiré (jusqu'à 12h sinon) — audit sécurité 2026-08-11 (E2).
    token_version INT NOT NULL DEFAULT 1,
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

-- Identifiants WhatsApp Business Cloud API propres à une organisation (server/src/whatsapp.js),
-- même logique que organisation_paydunya_config ci-dessus : chaque ferme (hors Massla elle-même,
-- voir organisations.est_plateforme) doit utiliser son propre compte WhatsApp Business pour
-- relancer SES clients, pas celui de Massla — configuré en self-service, voir
-- routes/parametres-whatsapp.js.
CREATE TABLE organisation_whatsapp_config (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    access_token_chiffre TEXT NOT NULL,
    phone_number_id_chiffre TEXT NOT NULL,
    template_nom VARCHAR(100) NOT NULL DEFAULT 'hello_world',
    template_langue VARCHAR(10) NOT NULL DEFAULT 'en_US',
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
    pin_tentatives_echouees INT NOT NULL DEFAULT 0, -- Verrouillage par compte (routes/portail.js) : un PIN à 6 chiffres a peu d'entropie, la limite par IP seule (express-rate-limit) est contournable en distribuant les tentatives sur plusieurs IP
    pin_bloque_jusqu TIMESTAMPTZ, -- Non NULL et dans le futur => connexion refusée même avec le bon PIN, jusqu'à expiration
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
    suivi_recolte BOOLEAN DEFAULT FALSE, -- coché pour un secteur de type culture (maturité/récolte à suivre), ex-"Maraîcher"
    parent_secteur_id INT REFERENCES secteurs(id), -- ex: "Bovins" a pour parent "Élevage" — profondeur max 1 niveau, validée côté route, pas en SQL
    suivi_individuel BOOLEAN NOT NULL DEFAULT FALSE -- coché pour un secteur suivi animal par animal (voir 3bis), pas par lot/effectif global
);

CREATE TABLE lots_production (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id),
    -- UNIQUE (tenant_id, code_lot) et non UNIQUE global (audit sécurité 2026-08-11, M3) : une
    -- contrainte globale empêchait DÉFINITIVEMENT deux fermes différentes d'utiliser le même code
    -- de lot (ex: 'A-45'), sans aucune raison métier de l'interdire entre fermes distinctes.
    code_lot VARCHAR(50) NOT NULL, -- ex: 'A-45'
    quantite_initiale INT NOT NULL,
    date_demarrage DATE NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('EN_COURS', 'ABATTAGE', 'TERMINE', 'PERDU')),
    culture VARCHAR(100), -- Maraîcher : type de culture (tomate, chou, ...) — planification des cultures
    duree_maturite_jours INT, -- Maraîcher : durée avant récolte prévue, en jours depuis date_demarrage
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    UNIQUE (tenant_id, code_lot)
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
-- 3bis. ÉLEVAGE INDIVIDUEL (bovins/ovins/caprins) — suivi animal par animal, pas par lot
-- --------------------------------------------------------
-- Un secteur `suivi_individuel = TRUE` (Bovins/Ovins/Caprins) porte des `animaux` au lieu de
-- `lots_production` — un ruminant a une valeur individuelle, une longue durée de vie, et une
-- identité qu'on veut suivre (poids, santé, reproduction), contrairement à un lot de volailles.
-- `reproductions` est déclarée avant `animaux` à cause de la FK `animaux.reproduction_id`.

CREATE TABLE reproductions (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    mere_id INT, -- FK vers animaux ajoutée après la création de la table animaux (dépendance circulaire)
    pere_id INT, -- optionnel ; FK ajoutée de même
    date_saillie DATE NOT NULL,
    date_mise_bas_prevue DATE, -- estimée côté client à la saisie (gestation par espèce), figée ici
    date_mise_bas_reelle DATE,
    nombre_petits INT,
    statut VARCHAR(15) CHECK (statut IN ('EN_COURS', 'MISE_BAS', 'ECHEC')) NOT NULL DEFAULT 'EN_COURS',
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE animaux (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id), -- toujours un secteur ENFANT (Bovins/Ovins/Caprins), jamais le parent "Élevage"
    identifiant VARCHAR(30) NOT NULL, -- boucle/tag, ex 'BOV-0042'
    espece VARCHAR(10) CHECK (espece IN ('BOVIN', 'OVIN', 'CAPRIN')) NOT NULL,
    race VARCHAR(50),
    sexe VARCHAR(1) CHECK (sexe IN ('M', 'F')) NOT NULL,
    date_naissance DATE,
    mere_id INT REFERENCES animaux(id), -- généalogie mère→petit uniquement (pas de pere_id sur l'animal lui-même)
    reproduction_id INT REFERENCES reproductions(id), -- regroupe les petits d'une même portée
    origine VARCHAR(10) CHECK (origine IN ('NE_FERME', 'ACHETE')) NOT NULL DEFAULT 'NE_FERME',
    statut VARCHAR(10) CHECK (statut IN ('VIVANT', 'VENDU', 'ABATTU', 'MORT')) NOT NULL DEFAULT 'VIVANT',
    date_sortie DATE, -- posée avec le statut à la sortie du troupeau (vente/abattage/mort)
    poids_initial_kg NUMERIC,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, identifiant) -- même convention que lots_production(tenant_id, code_lot) : pas d'unicité globale
);

CREATE INDEX idx_animaux_mere ON animaux(mere_id);
CREATE INDEX idx_animaux_secteur_statut ON animaux(secteur_id, statut);

ALTER TABLE reproductions ADD CONSTRAINT fk_reproductions_mere FOREIGN KEY (mere_id) REFERENCES animaux(id);
ALTER TABLE reproductions ADD CONSTRAINT fk_reproductions_pere FOREIGN KEY (pere_id) REFERENCES animaux(id);

-- Historique d'événements par animal (pesée/vaccination/traitement/observation) — table séparée de
-- `releves_journaliers` : celle-ci est câblée sur POST /production/sync (offline PWA par lot), y
-- mélanger le suivi par animal serait fragile. Pas de champ est_synchronise : pas de mode hors-ligne
-- pour l'élevage dans cette version.
CREATE TABLE releves_animal (
    id SERIAL PRIMARY KEY,
    animal_id INT REFERENCES animaux(id) ON DELETE CASCADE,
    utilisateur_id INT REFERENCES utilisateurs(id),
    date_releve DATE NOT NULL,
    type_evenement VARCHAR(20) CHECK (type_evenement IN ('PESEE', 'VACCINATION', 'TRAITEMENT', 'OBSERVATION')) NOT NULL,
    poids_kg NUMERIC, -- pertinent seulement pour PESEE
    produit_utilise VARCHAR(150), -- nom du vaccin/traitement
    notes TEXT,
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
    -- UNIQUE (tenant_id, numero_commande) et non UNIQUE global (audit sécurité 2026-08-11, M3) :
    -- voir numero.js pour le générateur (corrigé le même jour — l'ancien produisait de vraies
    -- collisions en production, contrainte globale ou pas).
    numero_commande VARCHAR(20) NOT NULL, -- ex: 'CMD-8492'
    client_id INT REFERENCES clients(id),
    statut VARCHAR(20) CHECK (statut IN ('EN_ATTENTE', 'PREPAREE', 'EN_LIVRAISON', 'LIVREE', 'ANNULEE')),
    montant_total NUMERIC NOT NULL,
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, numero_commande)
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
    -- Valeur envoyée à PayDunya à l'initiation (custom_data.reference_interne, voir paydunya.js) et
    -- renvoyée telle quelle dans l'IPN de confirmation : sert de vérification croisée du montant/
    -- référence à la réception de l'IPN (routes/finance.js), en plus du token lui-même — audit
    -- développement 2026-08-11 (liste "Ensuite"), jamais implémenté avant cette colonne.
    reference_interne VARCHAR(150),
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
    -- UNIQUE (tenant_id, numero_commande) et non UNIQUE global (audit sécurité 2026-08-11, M3) —
    -- même raisonnement que commandes.numero_commande ci-dessus.
    numero_commande VARCHAR(20) NOT NULL, -- ex: 'CMF-8492'
    fournisseur_id INT REFERENCES fournisseurs(id),
    statut VARCHAR(20) CHECK (statut IN ('COMMANDEE', 'RECUE', 'ANNULEE')) DEFAULT 'COMMANDEE',
    date_commande DATE NOT NULL DEFAULT CURRENT_DATE,
    date_livraison_prevue DATE,
    date_livraison_reelle DATE, -- renseignée à la réception : base du suivi des délais fournisseur
    montant_total NUMERIC NOT NULL DEFAULT 0,
    notes TEXT,
    cree_par INT REFERENCES utilisateurs(id),
    deleted_at TIMESTAMP,
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (tenant_id, numero_commande)
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
-- 7ter. IMMOBILISATIONS (inventaire, entretien, amortissement — section de l'onglet Comptabilité)
-- --------------------------------------------------------

CREATE TABLE equipements (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id), -- NULL = matériel partagé entre secteurs (ex: véhicule de livraison)
    fournisseur_id INT REFERENCES fournisseurs(id), -- NULL = fournisseur non renseigné/inconnu
    nom VARCHAR(150) NOT NULL, -- ex: 'Motoculteur', 'Pompe à eau', 'Groupe électrogène'
    categorie VARCHAR(50), -- libre, ex: 'Motoculture', 'Irrigation', 'Transport', 'Autre'
    etat VARCHAR(20) CHECK (etat IN ('Bon', 'A réparer', 'Hors service')) DEFAULT 'Bon',
    quantite INT NOT NULL DEFAULT 1,
    date_achat DATE,
    valeur_achat NUMERIC,
    -- Amortissement linéaire optionnel : NULL = non amortissable (ex: petit outillage déjà passé en
    -- dépense directe à l'achat) — voir routes/immobilisations.js POST /amortissements/calculer.
    duree_amortissement_mois INT,
    valeur_residuelle NUMERIC DEFAULT 0,
    -- Dénormalisé depuis entretiens_equipement.prochain_entretien (mis à jour à chaque entretien
    -- loggé) : évite un JOIN/sous-requête pour l'affichage liste + alerte "entretien à venir".
    prochain_entretien DATE,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Historique des entretiens ; chaque ligne peut générer une dépense (voir routes/immobilisations.js),
-- miroir du même principe que la réception d'une commande fournisseur (routes/fournisseurs.js).
CREATE TABLE entretiens_equipement (
    id SERIAL PRIMARY KEY,
    equipement_id INT REFERENCES equipements(id) ON DELETE CASCADE,
    date_entretien DATE NOT NULL,
    description TEXT,
    cout NUMERIC,
    prochain_entretien DATE,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Ledger des dotations d'amortissement déjà comptabilisées (une dépense postée par ligne) — UNIQUE
-- empêche de comptabiliser deux fois le même mois pour le même équipement si le comptable reclique
-- sur "Calculer les amortissements du mois".
CREATE TABLE amortissements (
    id SERIAL PRIMARY KEY,
    equipement_id INT REFERENCES equipements(id) ON DELETE CASCADE,
    periode DATE NOT NULL, -- 1er jour du mois comptabilisé, ex: 2026-09-01
    montant NUMERIC NOT NULL,
    depense_id INT REFERENCES depenses(id),
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (equipement_id, periode)
);

CREATE INDEX idx_equipements_prochain_entretien ON equipements(prochain_entretien);

-- --------------------------------------------------------
-- 7quater. PAIE (employés, bulletins — coût "main d'œuvre" de l'onglet Comptabilité)
-- --------------------------------------------------------

CREATE TABLE employes (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    secteur_id INT REFERENCES secteurs(id), -- NULL = personnel général (non rattaché à un pôle)
    nom_complet VARCHAR(150) NOT NULL,
    poste VARCHAR(100),
    telephone VARCHAR(30),
    date_embauche DATE,
    date_depart DATE, -- renseignée quand l'employé quitte, sans supprimer l'historique de paie
    salaire_brut_mensuel NUMERIC,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    deleted_at TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Les taux légaux de charges sociales (IPRES/CSS...) ne sont volontairement pas calculés par
-- l'application (évoluent, hors périmètre) : le comptable saisit le montant lui-même par bulletin.
CREATE TABLE bulletins_paie (
    id SERIAL PRIMARY KEY,
    employe_id INT REFERENCES employes(id) ON DELETE CASCADE,
    periode DATE NOT NULL, -- 1er jour du mois payé
    salaire_brut NUMERIC NOT NULL,
    charges_sociales NUMERIC NOT NULL DEFAULT 0,
    salaire_net NUMERIC NOT NULL, -- ce que l'employé perçoit réellement
    statut VARCHAR(20) CHECK (statut IN ('EN_ATTENTE', 'PAYE')) DEFAULT 'EN_ATTENTE',
    date_paiement DATE,
    depense_id INT REFERENCES depenses(id), -- posé au passage EN_ATTENTE -> PAYE (coût = brut + charges)
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (employe_id, periode)
);

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
    -- Distingue une action de support (superviseur en impersonation) d'une action normale de
    -- l'admin de la ferme, sans quoi les deux sont indiscernables dans le journal de la ferme
    -- cible — audit sécurité 2026-08-11 (E4). Propagées automatiquement par logAudit() (audit.js)
    -- depuis le jeton en cours, jamais renseignées à la main par un appelant.
    impersonation BOOLEAN NOT NULL DEFAULT FALSE,
    superviseur_id INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------
-- 8. FACTURATION SAAS (Massla facture les fermes clientes — pas leurs propres clients à elles,
--    déjà géré par organisation_paydunya_config/paiements). Géré exclusivement depuis la vue
--    plateforme (routes/plateforme.js, réservée au superviseur) : un admin de ferme normal n'a
--    jamais accès à ces deux tables, voir rls-policies.sql (policies is_plateforme_admin()-only,
--    aucun accès via tenant_id comme pour le reste du schéma).
-- --------------------------------------------------------

CREATE TABLE organisation_abonnement_saas (
    tenant_id INT PRIMARY KEY REFERENCES organisations(id),
    -- Purement descriptif (quoi afficher côté plateforme) — le montant réellement facturé chaque
    -- mois est montant_mensuel, négocié au cas par cas, jamais recalculé automatiquement à partir
    -- de cette liste : reflète la réalité commerciale (chaque ferme peut avoir un prix différent).
    modules_actifs TEXT[] NOT NULL DEFAULT '{}',
    montant_mensuel INT NOT NULL,
    frais_configuration INT,
    frais_configuration_facture BOOLEAN NOT NULL DEFAULT FALSE,
    actif BOOLEAN NOT NULL DEFAULT TRUE,
    -- Numéro WhatsApp à contacter pour les relances de facturation (voir routes/plateforme.js,
    -- POST .../factures-saas/:id/rappel-whatsapp) — pas forcément le numéro personnel de l'admin,
    -- peut être celui d'un comptable ou autre contact désigné par la ferme pour la facturation.
    telephone_contact VARCHAR(20),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE factures_saas (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES organisations(id),
    type VARCHAR(20) CHECK (type IN ('CONFIGURATION', 'ABONNEMENT')) NOT NULL,
    periode VARCHAR(7), -- 'YYYY-MM' pour un abonnement mensuel, NULL pour une facture de configuration
    montant INT NOT NULL,
    statut VARCHAR(20) CHECK (statut IN ('A_PAYER', 'PAYEE', 'EN_RETARD', 'ANNULEE')) NOT NULL DEFAULT 'A_PAYER',
    date_echeance DATE NOT NULL,
    date_paiement TIMESTAMP,
    methode_paiement VARCHAR(30), -- 'WAVE', 'VIREMENT', 'ESPECES', 'AUTRE' — collecte manuelle, pas de PayDunya ici
    notes TEXT,
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

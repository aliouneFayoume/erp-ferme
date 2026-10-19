const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { logAudit } = require('./audit');
const { genererSlugUnique } = require('./slug');
const { DUREE_ESSAI_JOURS } = require('./modulesSaas');

const JOUR_MS = 24 * 3600 * 1000;

/** Date au format AAAA-MM-JJ, `joursAvant` jours avant aujourd'hui (UTC, comme le reste des saisies de date). */
function dateIlYa(joursAvant, maintenant = new Date()) {
    return new Date(maintenant.getTime() - joursAvant * JOUR_MS).toISOString().slice(0, 10);
}

// Courbe d'un lot de poulets de chair de 42 jours (valeurs réalistes, déterministes : la démo doit être identique à chaque
// ouverture d'essai, sans hasard). Mortalité surtout la première semaine ; consommation en g/poulet/jour ; poids pesé
// chaque semaine (g).
const DUREE_LOT_DEMO_JOURS = 42;
const MORTALITE_SEMAINE_1 = [10, 8, 7, 6, 5, 4, 3];
const POIDS_PESEES_G = { 1: 45, 7: 180, 14: 450, 21: 900, 28: 1450, 35: 2000, 42: 2450 };

function consommationGParPoulet(jour) {
    // 15 g le premier jour jusqu'à ~190 g le dernier, croissance quasi linéaire
    return Math.round(15 + ((jour - 1) * (190 - 15)) / (DUREE_LOT_DEMO_JOURS - 1));
}

/**
 * Remplit la « Ferme démo — 2 000 poulets, lot n°12 » : un lot TERMINÉ (il n'entre donc ni dans la limite « 1 lot en cours »
 * de l'essai, ni dans les statistiques des lots actifs) avec 42 jours de relevés (mortalité, aliment, pesées). Marqué
 * est_demo pour s'afficher « Démo » et se supprimer en un clic. Porte aussi son BILAN (migration-36) : prix de l'aliment, coûts
 * (poussins, vaccins, main-d'œuvre) et deux ventes de poulets rattachées au lot — via un client et un produit « (démo) », eux
 * aussi marqués est_demo et supprimés avec le lot — pour qu'un nouvel utilisateur voie une marge complète en 60 secondes.
 * Doit tourner sur la connexion de la transaction de création, contexte tenant déjà posé (RLS).
 */
const PRIX_ALIMENT_KG_DEMO = 520;
const PRIX_POUSSIN_DEMO = 650;

async function semerFermeDemo(client, { tenantId, secteurId, utilisateurId, maintenant = new Date() }) {
    const effectifInitial = 2000;
    const debutIlYa = DUREE_LOT_DEMO_JOURS + 7; // lot terminé depuis une semaine
    const lotRes = await client.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, est_demo, prix_aliment_kg, cree_par)
         VALUES ($1, $2, $3, $4, $5, 'TERMINE', TRUE, $6, $7) RETURNING id`,
        [tenantId, secteurId, 'Lot n°12 (démo)', effectifInitial, dateIlYa(debutIlYa, maintenant), PRIX_ALIMENT_KG_DEMO, utilisateurId]
    );
    const lotId = lotRes.rows[0].id;

    let vivants = effectifInitial;
    for (let jour = 1; jour <= DUREE_LOT_DEMO_JOURS; jour += 1) {
        const mortalite = jour <= 7 ? MORTALITE_SEMAINE_1[jour - 1] : jour % 2 === 0 ? 1 : 0;
        vivants -= mortalite;
        const alimentKg = Math.round((vivants * consommationGParPoulet(jour)) / 1000);
        await client.query(
            `INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, est_synchronise)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
            [lotId, utilisateurId, dateIlYa(debutIlYa - (jour - 1), maintenant), mortalite, alimentKg, POIDS_PESEES_G[jour] || 0]
        );
    }

    // Coûts du lot (hors aliment, calculé depuis les relevés) : poussins, vaccins, un coup de main.
    const coutsDemo = [
        ['Poussins', `${effectifInitial} poussins à ${PRIX_POUSSIN_DEMO} FCFA`, effectifInitial * PRIX_POUSSIN_DEMO, debutIlYa],
        ['Vétérinaire', 'Vaccins et traitements', 85000, debutIlYa - 10],
        ["Main d'œuvre", 'Aide ponctuelle', 150000, debutIlYa - 25],
    ];
    for (const [categorie, libelle, montant, ilYa] of coutsDemo) {
        await client.query(
            `INSERT INTO couts_lot (tenant_id, lot_id, categorie, libelle, montant, date_cout, cree_par) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tenantId, lotId, categorie, libelle, montant, dateIlYa(ilYa, maintenant), utilisateurId]
        );
    }

    // Ventes : un client et un produit « (démo) » (téléphone factice, unique par ferme), puis deux commandes livrées dont les lignes
    // portent le lot — c'est ce rattachement qui alimente le bilan. Marqués est_demo : supprimés avec le lot (routes/essai.js).
    const clientRes = await client.query(
        `INSERT INTO clients (tenant_id, nom, type_client, telephone, est_demo) VALUES ($1, 'Client démo', 'B2C', $2, TRUE) RETURNING id`,
        [tenantId, `DEMO-${tenantId}`]
    );
    const produitRes = await client.query(
        `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, est_demo)
         VALUES ($1, $2, 'Poulet de chair (démo)', 'TETE', 3300, 3300, TRUE) RETURNING id`,
        [tenantId, secteurId]
    );
    await client.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, 0)`, [produitRes.rows[0].id]);
    const ventesDemo = [
        ['CMD-DEMO-1', 1000, 3300, 6],
        ['CMD-DEMO-2', 920, 3400, 3],
    ];
    for (const [numero, quantite, prix, ilYa] of ventesDemo) {
        const total = quantite * prix;
        const cmd = await client.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le)
             VALUES ($1, $2, $3, 'LIVREE', $4, TRUE, $5) RETURNING id`,
            [tenantId, numero, clientRes.rows[0].id, total, dateIlYa(ilYa, maintenant)]
        );
        await client.query(
            `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total, lot_id) VALUES ($1, $2, $3, $4, $5, $6)`,
            [cmd.rows[0].id, produitRes.rows[0].id, quantite, prix, total, lotId]
        );
    }
    return lotId;
}


// ---- Filière piscicole : « Bassin n°3 (démo) », un cycle de tilapia de 120 jours -------------------------------------------------
// Même principe que le lot de poulets (déterministe, TERMINÉ pour ne pas compter dans la limite « 1 lot en cours »), mais avec les
// mesures d'un pisciculteur : mortalité, aliment, poids et taille pesés tous les 15 jours, température et pH de l'eau.
const DUREE_BASSIN_DEMO_JOURS = 120;
const EFFECTIF_BASSIN_DEMO = 3000;
const POIDS_PESEES_POISSON_G = { 1: 5, 15: 15, 30: 40, 45: 80, 60: 130, 75: 190, 90: 250, 105: 310, 120: 370 };
const PRIX_ALIMENT_POISSON_KG_DEMO = 650;

/** Poids moyen (g) d'un jour donné, interpolé entre deux pesées : sert à calculer la ration, pas à être affiché. */
function poidsPoissonJour(jour) {
    const jours = Object.keys(POIDS_PESEES_POISSON_G).map(Number).sort((a, b) => a - b);
    const apres = jours.find((j) => j >= jour) || jours[jours.length - 1];
    const avant = [...jours].reverse().find((j) => j <= jour) || jours[0];
    if (avant === apres) return POIDS_PESEES_POISSON_G[avant];
    const part = (jour - avant) / (apres - avant);
    return POIDS_PESEES_POISSON_G[avant] + part * (POIDS_PESEES_POISSON_G[apres] - POIDS_PESEES_POISSON_G[avant]);
}

/** Taille moyenne (cm) d'un tilapia d'un poids donné (relation poids-longueur usuelle), arrondie au dixième. */
function taillePoissonCm(poidsG) {
    return Math.round(3.2 * Math.cbrt(poidsG) * 10) / 10;
}

/** Ration du jour : de 6 % de la biomasse (alevins) à 2 % (poissons de 370 g) — donne un indice de consommation d'environ 1,5. */
function tauxAlimentJour(jour) {
    return 0.06 - ((jour - 1) * (0.06 - 0.02)) / (DUREE_BASSIN_DEMO_JOURS - 1);
}

async function semerBassinDemo(client, { tenantId, secteurId, utilisateurId, maintenant = new Date() }) {
    const debutIlYa = DUREE_BASSIN_DEMO_JOURS + 7; // cycle terminé depuis une semaine
    // Comme dans l'application, quantite_initiale porte l'effectif ACTUEL du bassin : la mortalité y est déduite.
    const mortalites = [];
    for (let jour = 1; jour <= DUREE_BASSIN_DEMO_JOURS; jour += 1) mortalites.push(jour <= 10 ? 6 : jour % 3 === 0 ? 2 : 1);
    const effectifFinal = EFFECTIF_BASSIN_DEMO - mortalites.reduce((a, b) => a + b, 0);

    const lotRes = await client.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, est_demo, prix_aliment_kg, espece, cree_par)
         VALUES ($1, $2, $3, $4, $5, 'TERMINE', TRUE, $6, 'Tilapia', $7) RETURNING id`,
        [tenantId, secteurId, 'Bassin n°3 (démo)', effectifFinal, dateIlYa(debutIlYa, maintenant), PRIX_ALIMENT_POISSON_KG_DEMO, utilisateurId]
    );
    const lotId = lotRes.rows[0].id;

    let vivants = EFFECTIF_BASSIN_DEMO;
    for (let jour = 1; jour <= DUREE_BASSIN_DEMO_JOURS; jour += 1) {
        const mortalite = mortalites[jour - 1];
        vivants -= mortalite;
        const biomasseKg = (vivants * poidsPoissonJour(jour)) / 1000;
        const alimentKg = Math.round(biomasseKg * tauxAlimentJour(jour) * 10) / 10;
        const pesee = POIDS_PESEES_POISSON_G[jour];
        await client.query(
            `INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, taille_moyenne_cm, temperature_eau, ph_eau, est_synchronise)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)`,
            [
                lotId,
                utilisateurId,
                dateIlYa(debutIlYa - (jour - 1), maintenant),
                mortalite,
                alimentKg,
                pesee || 0,
                pesee ? taillePoissonCm(pesee) : null,
                27 + (jour % 5) * 0.5,
                Math.round((7.2 + (jour % 4) * 0.1) * 10) / 10,
            ]
        );
    }

    // Récolte vendue : un client et un produit « (démo) » marqués est_demo (supprimés avec le bassin), deux commandes livrées.
    const clientRes = await client.query(
        `INSERT INTO clients (tenant_id, nom, type_client, telephone, est_demo) VALUES ($1, 'Client démo', 'B2C', $2, TRUE) RETURNING id`,
        [tenantId, `DEMO-${tenantId}`]
    );
    const produitRes = await client.query(
        `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, est_demo)
         VALUES ($1, $2, 'Tilapia frais (démo)', 'KG', 2300, 2300, TRUE) RETURNING id`,
        [tenantId, secteurId]
    );
    await client.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, 0)`, [produitRes.rows[0].id]);
    const ventesDemo = [
        ['CMD-DEMO-1', 620, 2300, 6],
        ['CMD-DEMO-2', 400, 2400, 3],
    ];
    for (const [numero, quantite, prix, ilYa] of ventesDemo) {
        const total = quantite * prix;
        const cmd = await client.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le)
             VALUES ($1, $2, $3, 'LIVREE', $4, TRUE, $5) RETURNING id`,
            [tenantId, numero, clientRes.rows[0].id, total, dateIlYa(ilYa, maintenant)]
        );
        await client.query(
            `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total, lot_id) VALUES ($1, $2, $3, $4, $5, $6)`,
            [cmd.rows[0].id, produitRes.rows[0].id, quantite, prix, total, lotId]
        );
    }
    return lotId;
}

// ---- Filière maraîchère : « Tomate — parcelle A (démo) », un cycle de 90 jours ---------------------------------------------------
const DUREE_PARCELLE_DEMO_JOURS = 90;
const PLANTS_PARCELLE_DEMO = 400;

async function semerParcelleDemo(client, { tenantId, secteurId, utilisateurId, maintenant = new Date() }) {
    const debutIlYa = DUREE_PARCELLE_DEMO_JOURS + 7; // cycle terminé depuis une semaine
    // jour du cycle -> ce qui s'y est passé (intrants, plants perdus, récolte en kg)
    const evenements = {
        3: { mortalite: 8, notes: 'Plants morts après repiquage' },
        4: { mortalite: 5 },
        7: { mortalite: 4 },
        5: { intrants: 'Engrais NPK 15-15-15 (4 kg)' },
        14: { notes: 'Arrosage et sarclage' },
        20: { intrants: "Traitement bio : huile de neem (2 L)" },
        28: { notes: 'Arrosage et sarclage' },
        35: { intrants: 'Engrais urée (3 kg)' },
        42: { notes: 'Tuteurage des plants' },
        50: { intrants: 'Désherbage manuel' },
        60: { notes: 'Premiers fruits mûrs' },
    };
    const recoltes = [40, 60, 80, 95, 100, 95, 85, 70, 50, 35, 25]; // kg, un jour sur deux à partir du jour 70
    recoltes.forEach((kg, i) => {
        evenements[70 + i * 2] = { ...(evenements[70 + i * 2] || {}), recolte: kg };
    });
    const mortsTotal = Object.values(evenements).reduce((s, e) => s + (e.mortalite || 0), 0);

    const lotRes = await client.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, culture, duree_maturite_jours, est_demo, cree_par)
         VALUES ($1, $2, $3, $4, $5, 'TERMINE', 'Tomate', 75, TRUE, $6) RETURNING id`,
        [tenantId, secteurId, 'Tomate — parcelle A (démo)', PLANTS_PARCELLE_DEMO - mortsTotal, dateIlYa(debutIlYa, maintenant), utilisateurId]
    );
    const lotId = lotRes.rows[0].id;

    for (const [jour, e] of Object.entries(evenements).map(([j, v]) => [Number(j), v]).sort((a, b) => a[0] - b[0])) {
        await client.query(
            `INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite, intrants_utilises, quantite_recoltee_kg, notes, est_synchronise)
             VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
            [lotId, utilisateurId, dateIlYa(debutIlYa - (jour - 1), maintenant), e.mortalite || 0, e.intrants || null, e.recolte || null, e.notes || null]
        );
    }

    const clientRes = await client.query(
        `INSERT INTO clients (tenant_id, nom, type_client, telephone, est_demo) VALUES ($1, 'Client démo', 'B2C', $2, TRUE) RETURNING id`,
        [tenantId, `DEMO-${tenantId}`]
    );
    const produitRes = await client.query(
        `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, est_demo)
         VALUES ($1, $2, 'Tomate (démo)', 'KG', 450, 500, TRUE) RETURNING id`,
        [tenantId, secteurId]
    );
    await client.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, 0)`, [produitRes.rows[0].id]);
    const ventesDemo = [
        ['CMD-DEMO-1', 400, 450, 6],
        ['CMD-DEMO-2', 300, 480, 3],
    ];
    for (const [numero, quantite, prix, ilYa] of ventesDemo) {
        const total = quantite * prix;
        const cmd = await client.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le)
             VALUES ($1, $2, $3, 'LIVREE', $4, TRUE, $5) RETURNING id`,
            [tenantId, numero, clientRes.rows[0].id, total, dateIlYa(ilYa, maintenant)]
        );
        await client.query(
            `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total, lot_id) VALUES ($1, $2, $3, $4, $5, $6)`,
            [cmd.rows[0].id, produitRes.rows[0].id, quantite, prix, total, lotId]
        );
    }
    return lotId;
}

// ---- Filière élevage : un petit troupeau de bovins suivi animal par animal ----------------------------------------------------------
// [identifiant, sexe, race, âge en jours, poids à la première pesée (kg), gain quotidien (kg/j), jours depuis la 1re pesée, mère, sortie (jours)]
const TROUPEAU_DEMO = [
    ['BOV-D01', 'M', 'Gobra', 1460, 430, 0.15, 180, null, null],
    ['BOV-D02', 'F', 'Gobra', 1825, 300, 0.1, 180, null, null],
    ['BOV-D03', 'F', 'Gobra', 1460, 285, 0.1, 180, null, null],
    ['BOV-D04', 'F', 'Zébu Peul', 2190, 310, 0.08, 180, null, null],
    ['BOV-D05', 'F', 'Gobra', 730, 200, 0.4, 180, null, null],
    ['BOV-D06', 'M', 'Gobra', 540, 190, 0.5, 180, null, 10], // vendu il y a 10 jours
    ['BOV-D07', 'F', 'Gobra', 120, 70, 0.7, 120, 'BOV-D02', null], // veau né à la ferme, mère BOV-D02
];

async function semerTroupeauDemo(client, { tenantId, secteurId, utilisateurId, maintenant = new Date() }) {
    const ids = {};
    for (const [identifiant, sexe, race, ageJours, poids0, gain, joursPesees, mere, sortie] of TROUPEAU_DEMO) {
        const res = await client.query(
            `INSERT INTO animaux (tenant_id, secteur_id, identifiant, espece, race, sexe, date_naissance, mere_id, origine, statut, date_sortie, poids_initial_kg, est_demo, cree_par)
             VALUES ($1, $2, $3, 'BOVIN', $4, $5, $6, $7, 'NE_FERME', $8, $9, $10, TRUE, $11) RETURNING id`,
            [
                tenantId, secteurId, identifiant, race, sexe, dateIlYa(ageJours, maintenant), mere ? ids[mere] : null,
                sortie ? 'VENDU' : 'VIVANT', sortie ? dateIlYa(sortie, maintenant) : null, poids0, utilisateurId,
            ]
        );
        ids[identifiant] = res.rows[0].id;
        // une pesée par mois, jusqu'à la vente éventuelle
        for (let j = joursPesees; j >= 0; j -= 30) {
            if (sortie && j < sortie) break;
            const poids = Math.round((poids0 + gain * (joursPesees - j)) * 10) / 10;
            await client.query(
                `INSERT INTO releves_animal (animal_id, utilisateur_id, date_releve, type_evenement, poids_kg) VALUES ($1, $2, $3, 'PESEE', $4)`,
                [ids[identifiant], utilisateurId, dateIlYa(j, maintenant), poids]
            );
        }
        if (!sortie) {
            await client.query(
                `INSERT INTO releves_animal (animal_id, utilisateur_id, date_releve, type_evenement, produit_utilise, notes) VALUES ($1, $2, $3, 'VACCINATION', 'Vaccin charbon symptomatique', 'Campagne annuelle')`,
                [ids[identifiant], utilisateurId, dateIlYa(90, maintenant)]
            );
        }
    }
    for (const identifiant of ['BOV-D05', 'BOV-D07']) {
        await client.query(
            `INSERT INTO releves_animal (animal_id, utilisateur_id, date_releve, type_evenement, produit_utilise, notes) VALUES ($1, $2, $3, 'TRAITEMENT', 'Déparasitage (ivermectine)', 'Traitement préventif')`,
            [ids[identifiant], utilisateurId, dateIlYa(45, maintenant)]
        );
    }
    return Object.values(ids)[0];
}

/**
 * Filières proposées à l'inscription : le secteur créé, la démo et les modules suivent le choix. L'élevage individuel est un module
 * à part de l'offre (modulesSaas.js : « à la demande, module par module ») : l'essai ET le Pro d'une ferme d'élevage l'incluent
 * d'office via modules_actifs (le passage en Pro ne touche pas modules_actifs, voir paiementsSaas.js).
 */
const FILIERES_ESSAI = {
    avicole: { secteur: 'Avicole', suiviRecolte: false, modules: [], semer: semerFermeDemo },
    piscicole: { secteur: 'Piscicole', suiviRecolte: false, modules: [], semer: semerBassinDemo },
    maraicher: { secteur: 'Maraîcher', suiviRecolte: true, modules: [], semer: semerParcelleDemo },
    elevage: { secteur: 'Élevage', suiviRecolte: false, modules: ['elevage'], semer: semerTroupeauDemo },
};
function filiereValide(valeur) {
    return Object.prototype.hasOwnProperty.call(FILIERES_ESSAI, valeur) ? valeur : 'avicole';
}

/** Crée le(s) secteur(s) de la filière et renvoie celui qui porte la démo (pour l'élevage : « Bovins », enfant de « Élevage »). */
async function creerSecteursEssai(client, tenantId, filiere) {
    const f = FILIERES_ESSAI[filiere];
    const parent = await client.query(
        `INSERT INTO secteurs (tenant_id, nom, suivi_recolte, suivi_individuel) VALUES ($1, $2, $3, FALSE) RETURNING id`,
        [tenantId, f.secteur, f.suiviRecolte]
    );
    if (filiere !== 'elevage') return parent.rows[0].id;
    // Suivi individuel : les animaux se rattachent à un sous-secteur (Bovins/Ovins/Caprins), jamais au secteur parent.
    let bovins = null;
    for (const nom of ['Bovins', 'Ovins', 'Caprins']) {
        const enfant = await client.query(
            `INSERT INTO secteurs (tenant_id, nom, suivi_recolte, parent_secteur_id, suivi_individuel) VALUES ($1, $2, FALSE, $3, TRUE) RETURNING id`,
            [tenantId, nom, parent.rows[0].id]
        );
        if (nom === 'Bovins') bovins = enfant.rows[0].id;
    }
    return bovins;
}

/**
 * Crée une ferme d'ESSAI : organisation + abonnement ESSAI de 30 jours + secteur Avicole ou Piscicole (au choix) + un seul compte (le gérant, qui
 * s'identifie par son numéro WhatsApp : pas d'e-mail, mot de passe inutilisable) + la ferme démo. Une transaction.
 *
 * Choix de sécurité assumés (voir aussi migration-35) :
 * - mot_de_passe_hash = empreinte d'un secret aléatoire jeté : la connexion par mot de passe ne peut jamais aboutir pour ce
 *   compte, seul le code WhatsApp ouvre une session ;
 * - mfa_obligatoire = FALSE : le code WhatsApp EST l'unique facteur de ces comptes ; l'imposer en plus enverrait le gérant vers
 *   la configuration d'une application d'authentification, à l'opposé de « rien d'autre que téléphone et nom de ferme » ;
 * - email_verifie reste FALSE : il n'y a pas d'e-mail à vérifier, et aucun parcours ne permet d'en ajouter un sans vérification ;
 * - le numéro est enregistré non vérifié (telephone_verifie = FALSE) tant que le premier code n'a pas été saisi.
 */
async function creerFermeEssai(pool, { nomFerme, telephone, source, filiere: filiereDemandee }) {
    const filiere = filiereValide(filiereDemandee);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Même amorce que creerFerme.js : contexte explicite avant toute lecture/écriture sur cette connexion, créer une
        // organisation n'étant par nature rattaché à aucun tenant existant.
        await client.query("SELECT set_config('app.is_plateforme_admin', 'true', false)");

        const slug = await genererSlugUnique(client, nomFerme);
        const orgRes = await client.query(`INSERT INTO organisations (nom, slug) VALUES ($1, $2) RETURNING id`, [nomFerme, slug]);
        const tenantId = orgRes.rows[0].id;
        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);

        const secteurId = await creerSecteursEssai(client, tenantId, filiere);

        const roleRes = await client.query(`SELECT id FROM roles WHERE nom = 'admin'`);
        if (roleRes.rows.length === 0) throw new Error("Rôle 'admin' introuvable — la base n'est pas correctement initialisée.");

        const hashInutilisable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        const userRes = await client.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif,
                                        telephone, telephone_verifie, email_verifie, mfa_obligatoire)
             VALUES ($1, 'Gérant', NULL, $2, $3, TRUE, $4, FALSE, FALSE, FALSE)
             RETURNING id, nom_complet, email, secteur_id, tenant_id, token_version`,
            [tenantId, hashInutilisable, roleRes.rows[0].id, telephone]
        );
        const admin = userRes.rows[0];

        const maintenant = new Date();
        await client.query(
            `INSERT INTO organisation_abonnement_saas
               (tenant_id, modules_actifs, montant_mensuel, actif, telephone_contact, plan, essai_debut_le, essai_fin_le, source_inscription)
             VALUES ($1, $6, 0, TRUE, $2, 'ESSAI', $3, $4, $5)`,
            [tenantId, telephone, maintenant, new Date(maintenant.getTime() + DUREE_ESSAI_JOURS * JOUR_MS), source === 'demo' ? 'demo' : 'essai', FILIERES_ESSAI[filiere].modules]
        );

        await FILIERES_ESSAI[filiere].semer(client, { tenantId, secteurId, utilisateurId: admin.id, maintenant });

        await logAudit(client, {
            table: 'organisations',
            rowId: tenantId,
            action: 'CREATE',
            userId: admin.id,
            tenantId,
            details: { nomFerme, origine: 'essai_autonome', source: source === 'demo' ? 'demo' : 'essai', filiere },
        });

        await client.query('COMMIT');
        return { tenantId, admin, nomFerme, slug };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)").catch(() => {});
        client.release();
    }
}

module.exports = { creerFermeEssai, semerFermeDemo, semerBassinDemo, semerParcelleDemo, semerTroupeauDemo, filiereValide, FILIERES_ESSAI, DUREE_LOT_DEMO_JOURS, DUREE_BASSIN_DEMO_JOURS };

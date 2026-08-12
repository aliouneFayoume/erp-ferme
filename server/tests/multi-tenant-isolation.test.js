const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerUtilisateurEtToken, creerOrganisation } = require('./helpers/testApp');

// finance.js appelle désormais le vrai PayDunya (pas le webhook simulé du prototype d'origine) avec
// les identifiants propres à l'organisation — mocké ici pour tester l'isolation multi-tenant de la
// résolution d'identifiants sans dépendre du réseau.
jest.mock('../src/paydunya');
jest.mock('../src/paymentConfig');
const { creerFacture, confirmerFacture } = require('../src/paydunya');
const { getPaydunyaConfig } = require('../src/paymentConfig');

// Prototype multi-tenant : ces tests prouvent qu'aucune requête de clients.js / dashboard.js ne
// renvoie ou n'altère les données d'une autre organisation. Fixtures volontairement minimales et
// indépendantes de seed.js (qui provisionne le jeu de données de démo complet, pas adapté à un test
// ciblé sur l'isolement).

async function creerClientPourTenant(pool, tenantId, overrides = {}) {
    const c = {
        nom: 'Client Test',
        type_client: 'B2C',
        categorie_tarifaire: 'standard',
        telephone: `+22177${Math.floor(1000000 + Math.random() * 8999999)}`,
        limite_credit: 0,
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours)
         VALUES ($1, $2, $3, $4, $5, $6, 0) RETURNING *`,
        [tenantId, c.nom, c.type_client, c.categorie_tarifaire, c.telephone, c.limite_credit]
    );
    return res.rows[0];
}

async function creerSecteurPourTenant(pool, tenantId, nom, suiviRecolte = false) {
    const res = await pool.query(
        `INSERT INTO secteurs (tenant_id, nom, suivi_recolte) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, nom, suiviRecolte]
    );
    return res.rows[0].id;
}

async function creerProduitAvecStockPourTenant(pool, tenantId, secteurId, overrides = {}) {
    const p = {
        nom: 'Produit Test',
        unite_mesure: 'KG',
        prix_unitaire_b2b: 1000,
        prix_unitaire_b2c: 1500,
        prix_unitaire_grossiste: null,
        quantite_disponible: 100,
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tenantId, secteurId, p.nom, p.unite_mesure, p.prix_unitaire_b2b, p.prix_unitaire_b2c, p.prix_unitaire_grossiste]
    );
    await pool.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, $2)`, [res.rows[0].id, p.quantite_disponible]);
    return res.rows[0];
}

async function creerCommandePourTenant(pool, tenantId, clientId, montant, numero) {
    const res = await pool.query(
        `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, 'EN_ATTENTE', $4) RETURNING *`,
        [tenantId, numero, clientId, montant]
    );
    return res.rows[0];
}

async function creerLotPourTenant(pool, tenantId, secteurId, overrides = {}) {
    const l = {
        code_lot: `LOT-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        quantite_initiale: 100,
        date_demarrage: '2026-06-01',
        statut: 'EN_COURS',
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, secteurId, l.code_lot, l.quantite_initiale, l.date_demarrage, l.statut]
    );
    return res.rows[0];
}

async function creerUtilisateurPourTenant(pool, tenantId, overrides = {}) {
    const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = $1`, [overrides.role || 'livreur']);
    const email = overrides.email || `user-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.sn`;
    const res = await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id) VALUES ($1, $2, $3, 'x', $4) RETURNING *`,
        [tenantId, overrides.nom_complet || 'Utilisateur Test', email, roleRes.rows[0].id]
    );
    return res.rows[0];
}

describe('isolation multi-tenant — clients.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;
    let tokenB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        // clients.js appelle logAudit() sur POST/PUT/DELETE : il faut un vrai utilisateur en base
        // (pas juste un id fictif dans le token), sous peine de violer la FK audit_logs -> utilisateurs.
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        tokenB = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB });
        app = buildApp(pool, ['clients']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un admin ne voit que les clients de sa propre organisation', async () => {
        await creerClientPourTenant(pool, tenantA, { nom: 'Client A1', telephone: '+221770000001' });
        await creerClientPourTenant(pool, tenantA, { nom: 'Client A2', telephone: '+221770000002' });
        await creerClientPourTenant(pool, tenantB, { nom: 'Client B1', telephone: '+221770000003' });

        const resA = await request(app).get('/api/clients').set('Authorization', `Bearer ${tokenA}`);
        const resB = await request(app).get('/api/clients').set('Authorization', `Bearer ${tokenB}`);

        expect(resA.body.map((c) => c.nom).sort()).toEqual(['Client A1', 'Client A2']);
        expect(resB.body.map((c) => c.nom)).toEqual(['Client B1']);
    });

    test("impossible de modifier un client d'une autre organisation via son id", async () => {
        const clientB = await creerClientPourTenant(pool, tenantB, { nom: 'Client B1', telephone: '+221770000004' });

        const res = await request(app).put(`/api/clients/${clientB.id}`).set('Authorization', `Bearer ${tokenA}`).send({ nom: 'Piraté' });

        expect(res.status).toBe(404);
        const verif = await pool.query('SELECT nom FROM clients WHERE id = $1', [clientB.id]);
        expect(verif.rows[0].nom).toBe('Client B1');
    });

    test("impossible de supprimer un client d'une autre organisation via son id", async () => {
        const clientB = await creerClientPourTenant(pool, tenantB, { nom: 'Client B1', telephone: '+221770000005' });

        await request(app).delete(`/api/clients/${clientB.id}`).set('Authorization', `Bearer ${tokenA}`);

        const verif = await pool.query('SELECT deleted_at FROM clients WHERE id = $1', [clientB.id]);
        expect(verif.rows[0].deleted_at).toBeNull();
    });

    test("un client créé par une organisation n'est jamais visible par une autre", async () => {
        await request(app).post('/api/clients').set('Authorization', `Bearer ${tokenA}`).send({
            nom: 'Nouveau Client A',
            type_client: 'B2C',
            telephone: '+221770000006',
            gps_lat: 14.7,
            gps_lng: -17.4,
        });

        const resB = await request(app).get('/api/clients').set('Authorization', `Bearer ${tokenB}`);

        expect(resB.body.find((c) => c.nom === 'Nouveau Client A')).toBeUndefined();
    });
});

describe('isolation multi-tenant — dashboard.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantA });
        app = buildApp(pool, ['dashboard']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test("le chiffre d'affaires du jour ne compte que les commandes de sa propre organisation", async () => {
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000010' });
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000011' });
        await creerCommandePourTenant(pool, tenantA, clientA.id, 10000, 'CMD-A-1');
        await creerCommandePourTenant(pool, tenantB, clientB.id, 999999, 'CMD-B-1');

        const resA = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.chiffreAffairesJour).toBe(10000);
    });

    test('le stock total ne compte que les produits de sa propre organisation', async () => {
        const secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        const secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        await creerProduitAvecStockPourTenant(pool, tenantA, secteurA, { quantite_disponible: 50 });
        await creerProduitAvecStockPourTenant(pool, tenantB, secteurB, { quantite_disponible: 99999 });

        const resA = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.stockTotal).toBe(50);
    });

    test("l'encours B2B ne compte que les clients de sa propre organisation", async () => {
        await creerClientPourTenant(pool, tenantA, { type_client: 'B2B', telephone: '+221770000020' });
        await pool.query(`UPDATE clients SET solde_encours = 5000 WHERE tenant_id = $1`, [tenantA]);
        await creerClientPourTenant(pool, tenantB, { type_client: 'B2B', telephone: '+221770000021' });
        await pool.query(`UPDATE clients SET solde_encours = 999999 WHERE tenant_id = $1`, [tenantB]);

        const resA = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.encoursB2B).toBe(5000);
    });

    test('les récoltes proches ne comptent que les lots de sa propre organisation (secteur à suivi de récolte)', async () => {
        const secteurRecolteA = await creerSecteurPourTenant(pool, tenantA, 'Culture A', true);
        const secteurRecolteB = await creerSecteurPourTenant(pool, tenantB, 'Culture B', true);
        // date_demarrage + 30j de maturité = dans 3 jours (≤ 7j, donc compté comme "récolte proche")
        const dateDemarrage = new Date(Date.now() - 27 * 86400000).toISOString().slice(0, 10);
        await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, duree_maturite_jours)
             VALUES ($1, $2, 'LOT-A', 10, $3, 'EN_COURS', 30)`,
            [tenantA, secteurRecolteA, dateDemarrage]
        );
        await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, duree_maturite_jours)
             VALUES ($1, $2, 'LOT-B', 10, $3, 'EN_COURS', 30)`,
            [tenantB, secteurRecolteB, dateDemarrage]
        );

        const resA = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.recoltesProches).toBe(1);
    });
});

// -----------------------------------------------------------------------------------------------
// Phase 2 : extension aux 10 autres fichiers de routes (même motif, tests ciblés par fichier).
// -----------------------------------------------------------------------------------------------

describe('isolation multi-tenant — abonnements.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['abonnements']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des abonnements ne montre que ceux de sa propre organisation', async () => {
        const secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        const secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000030' });
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000031' });
        const produitA = await creerProduitAvecStockPourTenant(pool, tenantA, secteurA);
        const produitB = await creerProduitAvecStockPourTenant(pool, tenantB, secteurB);
        await pool.query(
            `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, jour_livraison, actif) VALUES ($1, $2, $3, 1, 'LUNDI', TRUE)`,
            [tenantA, clientA.id, produitA.id]
        );
        await pool.query(
            `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, jour_livraison, actif) VALUES ($1, $2, $3, 1, 'LUNDI', TRUE)`,
            [tenantB, clientB.id, produitB.id]
        );

        const resA = await request(app).get('/api/abonnements').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body).toHaveLength(1);
        expect(resA.body[0].client_id).toBe(clientA.id);
    });

    test('generer-commandes ne génère que pour les abonnements de sa propre organisation', async () => {
        const JOURS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
        const jourDuJour = JOURS[new Date().getUTCDay()];
        const secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        const secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000032' });
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000033' });
        const produitA = await creerProduitAvecStockPourTenant(pool, tenantA, secteurA, { quantite_disponible: 50 });
        const produitB = await creerProduitAvecStockPourTenant(pool, tenantB, secteurB, { quantite_disponible: 50 });
        await pool.query(
            `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, jour_livraison, actif) VALUES ($1, $2, $3, 1, $4, TRUE)`,
            [tenantA, clientA.id, produitA.id, jourDuJour]
        );
        await pool.query(
            `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, jour_livraison, actif) VALUES ($1, $2, $3, 1, $4, TRUE)`,
            [tenantB, clientB.id, produitB.id, jourDuJour]
        );

        const res = await request(app).post('/api/abonnements/generer-commandes').set('Authorization', `Bearer ${tokenA}`);

        expect(res.body.creees).toBe(1);
        const commandes = await pool.query(`SELECT tenant_id FROM commandes WHERE tenant_id = $1`, [tenantA]);
        expect(commandes.rows).toHaveLength(1);
        const commandesB = await pool.query(`SELECT tenant_id FROM commandes WHERE tenant_id = $1`, [tenantB]);
        expect(commandesB.rows).toHaveLength(0);
    });
});

describe('isolation multi-tenant — audit.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;
    let tokenB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        tokenB = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB });
        app = buildApp(pool, ['clients', 'audit']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test("le journal d'audit d'une organisation ne montre jamais les actions d'une autre", async () => {
        await request(app).post('/api/clients').set('Authorization', `Bearer ${tokenA}`).send({
            nom: 'Client A', type_client: 'B2C', telephone: '+221770000040', gps_lat: 14.7, gps_lng: -17.4,
        });
        await request(app).post('/api/clients').set('Authorization', `Bearer ${tokenB}`).send({
            nom: 'Client B', type_client: 'B2C', telephone: '+221770000041', gps_lat: 14.7, gps_lng: -17.4,
        });

        const resA = await request(app).get('/api/audit').set('Authorization', `Bearer ${tokenA}`);

        const noms = resA.body.map((l) => l.details && JSON.parse(typeof l.details === 'string' ? l.details : JSON.stringify(l.details))?.nom);
        expect(noms).toContain('Client A');
        expect(noms).not.toContain('Client B');
    });
});

describe('isolation multi-tenant — catalogue.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;
    let secteurA;
    let secteurB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['catalogue']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des produits ne montre que ceux de sa propre organisation', async () => {
        await creerProduitAvecStockPourTenant(pool, tenantA, secteurA, { nom: 'Produit A' });
        await creerProduitAvecStockPourTenant(pool, tenantB, secteurB, { nom: 'Produit B' });

        const resA = await request(app).get('/api/catalogue/produits').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.map((p) => p.nom)).toEqual(['Produit A']);
    });

    test("impossible de créer un produit rattaché au secteur d'une autre organisation", async () => {
        const res = await request(app).post('/api/catalogue/produits').set('Authorization', `Bearer ${tokenA}`).send({
            secteur_id: secteurB, nom: 'Produit Suspect', unite_mesure: 'KG', prix_unitaire_b2b: 100, prix_unitaire_b2c: 150,
        });

        expect(res.status).toBe(400);
    });
});

describe('isolation multi-tenant — commandes.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['commandes']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des commandes ne montre que celles de sa propre organisation', async () => {
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000050' });
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000051' });
        await creerCommandePourTenant(pool, tenantA, clientA.id, 1000, 'CMD-A-1');
        await creerCommandePourTenant(pool, tenantB, clientB.id, 2000, 'CMD-B-1');

        const resA = await request(app).get('/api/commandes').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.map((c) => c.numero_commande)).toEqual(['CMD-A-1']);
    });

    test("impossible de consulter ou modifier le statut d'une commande d'une autre organisation via son id", async () => {
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000052' });
        const commandeB = await creerCommandePourTenant(pool, tenantB, clientB.id, 2000, 'CMD-B-2');

        const resGet = await request(app).get(`/api/commandes/${commandeB.id}`).set('Authorization', `Bearer ${tokenA}`);
        const resPut = await request(app).put(`/api/commandes/${commandeB.id}/statut`).set('Authorization', `Bearer ${tokenA}`).send({ statut: 'ANNULEE' });

        expect(resGet.status).toBe(404);
        expect(resPut.status).toBe(404);
        const verif = await pool.query('SELECT statut FROM commandes WHERE id = $1', [commandeB.id]);
        expect(verif.rows[0].statut).toBe('EN_ATTENTE');
    });
});

describe('isolation multi-tenant — comptabilite.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantA });
        app = buildApp(pool, ['comptabilite']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des dépenses ne montre que celles de sa propre organisation', async () => {
        await pool.query(
            `INSERT INTO depenses (tenant_id, categorie, montant, date_depense) VALUES ($1, 'Aliment', 1000, '2026-07-01')`,
            [tenantA]
        );
        await pool.query(
            `INSERT INTO depenses (tenant_id, categorie, montant, date_depense) VALUES ($1, 'Aliment', 999999, '2026-07-01')`,
            [tenantB]
        );

        const resA = await request(app).get('/api/comptabilite/depenses').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body).toHaveLength(1);
        expect(Number(resA.body[0].montant)).toBe(1000);
    });

    test("l'analytique par pôle ne mélange jamais le chiffre d'affaires ou les dépenses entre organisations", async () => {
        const secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        const secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        await pool.query(
            `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, date_depense) VALUES ($1, $2, 'Aliment', 500, '2026-07-01')`,
            [tenantA, secteurA]
        );
        await pool.query(
            `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, date_depense) VALUES ($1, $2, 'Aliment', 999999, '2026-07-01')`,
            [tenantB, secteurB]
        );

        const resA = await request(app).get('/api/comptabilite/analytique').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body.parPole).toHaveLength(1);
        expect(resA.body.parPole[0].depenses).toBe(500);
    });
});

describe('isolation multi-tenant — finance.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantA });
        app = buildApp(pool, ['finance']);
        creerFacture.mockReset();
        confirmerFacture.mockReset();
        getPaydunyaConfig.mockReset();
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des paiements ne montre que ceux de sa propre organisation', async () => {
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000060' });
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000061' });
        const commandeA = await creerCommandePourTenant(pool, tenantA, clientA.id, 1000, 'CMD-A-3');
        const commandeB = await creerCommandePourTenant(pool, tenantB, clientB.id, 2000, 'CMD-B-3');
        await pool.query(
            `INSERT INTO paiements (tenant_id, commande_id, client_id, montant, methode_paiement, statut) VALUES ($1, $2, $3, 1000, 'ESPECES', 'VALIDE')`,
            [tenantA, commandeA.id, clientA.id]
        );
        await pool.query(
            `INSERT INTO paiements (tenant_id, commande_id, client_id, montant, methode_paiement, statut) VALUES ($1, $2, $3, 2000, 'ESPECES', 'VALIDE')`,
            [tenantB, commandeB.id, clientB.id]
        );

        const resA = await request(app).get('/api/finance/paiements').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body).toHaveLength(1);
        expect(Number(resA.body[0].montant)).toBe(1000);
    });

    test("l'IPN PayDunya crédite le paiement de la bonne organisation en utilisant SES identifiants, sans jamais toucher à l'autre", async () => {
        const credentialsA = { mode: 'test', masterKey: 'mkA', privateKey: 'pkA', publicKey: 'pubA', token: 'tkA' };
        const credentialsB = { mode: 'test', masterKey: 'mkB', privateKey: 'pkB', publicKey: 'pubB', token: 'tkB' };
        // getPaydunyaConfig doit renvoyer les identifiants DE L'ORGANISATION DEMANDÉE, jamais ceux
        // d'une autre — c'est exactement le point que ce test vérifie.
        getPaydunyaConfig.mockImplementation(async (_pool, tenantId) => (tenantId === tenantA ? credentialsA : credentialsB));

        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000062' });
        const commandeA = await creerCommandePourTenant(pool, tenantA, clientA.id, 5000, 'CMD-A-4');
        await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, '2026-08-01', 'A_PAYER', 5000)`,
            [tenantA, commandeA.id]
        );

        creerFacture.mockResolvedValue({ token: 'paydunya-token-A', url: 'https://paydunya.test/checkout/A' });
        const initier = await request(app).post('/api/finance/paiements/initier').set('Authorization', `Bearer ${tokenA}`).send({
            commande_id: commandeA.id, client_id: clientA.id, montant: 5000, provider: 'WAVE',
        });
        expect(initier.status).toBe(201);
        // La facture PayDunya doit avoir été créée avec les identifiants de l'organisation A, pas B.
        expect(creerFacture).toHaveBeenCalledWith(expect.objectContaining({ credentials: credentialsA }));

        // La confirmation PayDunya renvoie la reference_interne telle qu'elle a été générée à
        // l'initiation (voir vérification croisée dans routes/finance.js) — on la relit en base
        // plutôt que de la deviner, exactement comme le ferait PayDunya en la faisant l'aller-retour.
        const paiementA = await pool.query(`SELECT reference_interne FROM paiements WHERE reference_transaction = 'paydunya-token-A'`);
        confirmerFacture.mockResolvedValue({ status: 'completed', montant: 5000, providerReference: 'PD-A', referenceInterne: paiementA.rows[0].reference_interne });
        const ipn = await request(app).post('/api/finance/paiements/ipn').send({ data: { token: 'paydunya-token-A' } });

        expect(ipn.status).toBe(200);
        // L'IPN n'avait aucun contexte tenant : elle a dû retrouver l'organisation A elle-même
        // (via le paiement en attente) puis appeler PayDunya avec SES clés, pas celles de B.
        expect(confirmerFacture).toHaveBeenCalledWith('paydunya-token-A', credentialsA);
        const facture = await pool.query(`SELECT statut FROM factures WHERE commande_id = $1`, [commandeA.id]);
        expect(facture.rows[0].statut).toBe('PAYEE');
    });

    test('sans agrégateur PayDunya configuré pour son organisation, une initiation de paiement échoue proprement', async () => {
        getPaydunyaConfig.mockResolvedValue(null);
        const clientA = await creerClientPourTenant(pool, tenantA, { telephone: '+221770000063' });
        const commandeA = await creerCommandePourTenant(pool, tenantA, clientA.id, 3000, 'CMD-A-5');

        const initier = await request(app).post('/api/finance/paiements/initier').set('Authorization', `Bearer ${tokenA}`).send({
            commande_id: commandeA.id, client_id: clientA.id, montant: 3000, provider: 'WAVE',
        });

        expect(initier.status).toBe(400);
        expect(creerFacture).not.toHaveBeenCalled();
    });
});

describe('isolation multi-tenant — logistique.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantA });
        app = buildApp(pool, ['logistique']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des caisses chauffeur ne montre que celles de sa propre organisation', async () => {
        const livreurA = await creerUtilisateurPourTenant(pool, tenantA, { role: 'livreur' });
        const livreurB = await creerUtilisateurPourTenant(pool, tenantB, { role: 'livreur' });
        await pool.query(`INSERT INTO caisses_chauffeur (tenant_id, livreur_id, date_caisse, statut) VALUES ($1, $2, '2026-07-01', 'OUVERTE')`, [tenantA, livreurA.id]);
        await pool.query(`INSERT INTO caisses_chauffeur (tenant_id, livreur_id, date_caisse, statut) VALUES ($1, $2, '2026-07-01', 'OUVERTE')`, [tenantB, livreurB.id]);

        const resA = await request(app).get('/api/logistique/caisse').set('Authorization', `Bearer ${tokenA}`);

        expect(resA.body).toHaveLength(1);
        expect(resA.body[0].livreur_id).toBe(livreurA.id);
    });

    test("impossible de créer une livraison pour une commande d'une autre organisation", async () => {
        const clientB = await creerClientPourTenant(pool, tenantB, { telephone: '+221770000070' });
        const commandeB = await creerCommandePourTenant(pool, tenantB, clientB.id, 1000, 'CMD-B-5');
        const livreurA = await creerUtilisateurPourTenant(pool, tenantA, { role: 'livreur' });

        const res = await request(app).post('/api/logistique/livraisons').set('Authorization', `Bearer ${tokenA}`).send({
            commande_id: commandeB.id, livreur_id: livreurA.id, date_prevue: '2026-07-20',
        });

        expect(res.status).toBe(400);
    });
});

describe('isolation multi-tenant — production.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;
    let secteurA;
    let secteurB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        secteurA = await creerSecteurPourTenant(pool, tenantA, 'Secteur A');
        secteurB = await creerSecteurPourTenant(pool, tenantB, 'Secteur B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des secteurs ne montre que ceux de sa propre organisation', async () => {
        const res = await request(app).get('/api/production/secteurs').set('Authorization', `Bearer ${tokenA}`);
        expect(res.body.map((s) => s.id)).toEqual([secteurA]);
    });

    test("verifierAccesLot refuse l'accès à un lot d'une autre organisation, même pour un admin", async () => {
        const lotB = await creerLotPourTenant(pool, tenantB, secteurB);

        const res = await request(app).put(`/api/production/lots/${lotB.id}/statut`).set('Authorization', `Bearer ${tokenA}`).send({ statut: 'TERMINE' });

        expect(res.status).toBe(403);
        const verif = await pool.query('SELECT statut FROM lots_production WHERE id = $1', [lotB.id]);
        expect(verif.rows[0].statut).toBe('EN_COURS');
    });
});

describe('isolation multi-tenant — utilisateurs.js', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenA;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['utilisateurs']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la liste des utilisateurs ne montre que ceux de sa propre organisation', async () => {
        await creerUtilisateurPourTenant(pool, tenantA, { nom_complet: 'Utilisateur A' });
        await creerUtilisateurPourTenant(pool, tenantB, { nom_complet: 'Utilisateur B' });

        const resA = await request(app).get('/api/utilisateurs').set('Authorization', `Bearer ${tokenA}`);

        const noms = resA.body.map((u) => u.nom_complet);
        expect(noms).toContain('Utilisateur A');
        expect(noms).not.toContain('Utilisateur B');
    });

    test("impossible de modifier ou supprimer un utilisateur d'une autre organisation via son id", async () => {
        const userB = await creerUtilisateurPourTenant(pool, tenantB, { nom_complet: 'Utilisateur B' });

        const resPut = await request(app).put(`/api/utilisateurs/${userB.id}`).set('Authorization', `Bearer ${tokenA}`).send({ nom_complet: 'Piraté' });
        const resDelete = await request(app).delete(`/api/utilisateurs/${userB.id}`).set('Authorization', `Bearer ${tokenA}`);

        expect(resPut.status).toBe(404);
        expect(resDelete.status).toBe(404);
        const verif = await pool.query('SELECT nom_complet, deleted_at FROM utilisateurs WHERE id = $1', [userB.id]);
        expect(verif.rows[0].nom_complet).toBe('Utilisateur B');
        expect(verif.rows[0].deleted_at).toBeNull();
    });
});

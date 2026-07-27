const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, tokenPour, creerUtilisateurEtToken } = require('./helpers/testApp');

// Prototype multi-tenant : ces tests prouvent qu'aucune requête de clients.js / dashboard.js ne
// renvoie ou n'altère les données d'une autre organisation. Fixtures volontairement minimales et
// indépendantes de seed.js (qui provisionne le jeu de données de démo complet, pas adapté à un test
// ciblé sur l'isolement).

async function creerOrganisation(pool, nom) {
    const res = await pool.query(`INSERT INTO organisations (nom) VALUES ($1) RETURNING id`, [nom]);
    return res.rows[0].id;
}

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
        tokenA = tokenPour({ role: 'comptable', tenant_id: tenantA });
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

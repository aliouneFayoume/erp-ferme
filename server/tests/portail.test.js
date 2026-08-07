const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerClient, creerProduitAvecStock } = require('./helpers/testApp');

/** Attribue un PIN à un client de test et renvoie le PIN en clair. */
async function definirPin(pool, clientId, pin = '123456') {
    const hash = await bcrypt.hash(pin, 10);
    await pool.query(`UPDATE clients SET pin_hash = $1, pin_version = pin_version + 1 WHERE id = $2`, [hash, clientId]);
    return pin;
}

describe('portail client', () => {
    let pool;
    let app;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['portail']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('login avec téléphone + PIN corrects renvoie un token', async () => {
        const client = await creerClient(pool, { telephone: '+221770000001' });
        const pin = await definirPin(pool, client.id);

        const res = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.client.id).toBe(client.id);
    });

    test('login avec mauvais PIN renvoie 401', async () => {
        const client = await creerClient(pool, { telephone: '+221770000002' });
        await definirPin(pool, client.id, '111111');

        const res = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin: '000000' });
        expect(res.status).toBe(401);
    });

    test('un client ne peut pas voir les commandes d\'un autre client', async () => {
        const clientA = await creerClient(pool, { telephone: '+221770000003' });
        const clientB = await creerClient(pool, { telephone: '+221770000004' });
        const pinA = await definirPin(pool, clientA.id);

        const produit = await creerProduitAvecStock(pool);
        await pool.query(
            `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-B', $1, 'EN_ATTENTE', 5000)`,
            [clientB.id]
        );

        const login = await request(app).post('/api/portail/login').send({ telephone: clientA.telephone, pin: pinA });
        const res = await request(app).get('/api/portail/commandes').set('Authorization', `Bearer ${login.body.token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(0);
        void produit;
    });

    test('un client ne peut pas ouvrir la facture d\'un autre client (IDOR)', async () => {
        const clientA = await creerClient(pool, { telephone: '+221770000005' });
        const clientB = await creerClient(pool, { telephone: '+221770000006' });
        const pinA = await definirPin(pool, clientA.id);

        const commandeB = await pool.query(
            `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-C', $1, 'EN_ATTENTE', 5000) RETURNING id`,
            [clientB.id]
        );
        const factureB = await pool.query(
            `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, CURRENT_DATE, 'A_PAYER', 5000) RETURNING id`,
            [commandeB.rows[0].id]
        );

        const login = await request(app).post('/api/portail/login').send({ telephone: clientA.telephone, pin: pinA });
        const res = await request(app)
            .get(`/api/portail/factures/${factureB.rows[0].id}/pdf`)
            .set('Authorization', `Bearer ${login.body.token}`);

        expect(res.status).toBe(404);
    });

    test('régénérer le PIN invalide les sessions déjà émises', async () => {
        const client = await creerClient(pool, { telephone: '+221770000007' });
        const pin = await definirPin(pool, client.id, '222222');
        const login = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin });
        const ancienToken = login.body.token;

        await definirPin(pool, client.id, '333333');

        const res = await request(app).get('/api/portail/moi').set('Authorization', `Bearer ${ancienToken}`);
        expect(res.status).toBe(401);
    });

    test('un client peut créer un ticket et y ajouter un message', async () => {
        const client = await creerClient(pool, { telephone: '+221770000008' });
        const pin = await definirPin(pool, client.id);
        const login = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin });
        const token = login.body.token;

        const creation = await request(app)
            .post('/api/portail/tickets')
            .set('Authorization', `Bearer ${token}`)
            .send({ sujet: 'Colis en retard' });
        expect(creation.status).toBe(201);

        const message = await request(app)
            .post(`/api/portail/tickets/${creation.body.id}/messages`)
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'Bonjour, des nouvelles ?' });
        expect(message.status).toBe(201);

        const fil = await request(app).get(`/api/portail/tickets/${creation.body.id}/messages`).set('Authorization', `Bearer ${token}`);
        expect(fil.body).toHaveLength(1);
        expect(fil.body[0].auteur_type).toBe('client');
    });

    test('sans token, toutes les routes renvoient 401', async () => {
        const res = await request(app).get('/api/portail/commandes');
        expect(res.status).toBe(401);
    });
});

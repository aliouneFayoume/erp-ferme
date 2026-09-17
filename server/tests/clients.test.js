const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

function payloadClientValide(overrides = {}) {
    return {
        nom: 'Awa Diouf',
        type_client: 'B2C',
        categorie_tarifaire: 'standard',
        telephone: '221700000099',
        adresse: 'Près de la pharmacie',
        gps_lat: 14.7167,
        gps_lng: -17.4677,
        ...overrides,
    };
}

describe('clients — annuaire et adressage GPS', () => {
    let pool;
    let app;
    let token;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['clients']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('rejette la création sans point GPS', async () => {
        const res = await request(app)
            .post('/api/clients')
            .set('Authorization', `Bearer ${token}`)
            .send(payloadClientValide({ gps_lat: null, gps_lng: null }));
        expect(res.status).toBe(400);
    });

    test('crée un client avec GPS puis le liste', async () => {
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide());
        expect(creation.status).toBe(201);
        expect(Number(creation.body.gps_lat)).toBeCloseTo(14.7167);

        const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${token}`);
        expect(liste.status).toBe(200);
        expect(liste.body).toHaveLength(1);
        expect(liste.body[0].nom).toBe('Awa Diouf');
    });

    test('modifie le nom, le téléphone et le GPS d\'un client existant', async () => {
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide());

        const modif = await request(app)
            .put(`/api/clients/${creation.body.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ nom: 'Awa Diouf Ndoye', telephone: '221700000088', gps_lat: 14.72, gps_lng: -17.45 });

        expect(modif.status).toBe(200);
        expect(modif.body.nom).toBe('Awa Diouf Ndoye');
        expect(modif.body.telephone).toBe('221700000088');
        expect(Number(modif.body.gps_lat)).toBeCloseTo(14.72);
        expect(Number(modif.body.gps_lng)).toBeCloseTo(-17.45);
    });

    test('conserve les champs non transmis lors d\'une modification partielle', async () => {
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide({ limite_credit: 50000 }));

        const modif = await request(app)
            .put(`/api/clients/${creation.body.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ nom: 'Awa Diouf Ndoye' });

        expect(modif.status).toBe(200);
        expect(Number(modif.body.gps_lat)).toBeCloseTo(14.7167);
        expect(Number(modif.body.limite_credit)).toBe(50000);
    });

    test('404 sur la modification d\'un client inexistant', async () => {
        const res = await request(app)
            .put('/api/clients/999999')
            .set('Authorization', `Bearer ${token}`)
            .send({ nom: 'Fantôme' });
        expect(res.status).toBe(404);
    });

    test('un client d\'une autre ferme est invisible et non modifiable (isolation tenant)', async () => {
        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const autreToken = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: autreTenantId });
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide());

        const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${autreToken}`);
        expect(liste.body).toHaveLength(0);

        const modif = await request(app)
            .put(`/api/clients/${creation.body.id}`)
            .set('Authorization', `Bearer ${autreToken}`)
            .send({ nom: 'Piraté' });
        expect(modif.status).toBe(404);
    });

    test('seul un admin peut supprimer un client', async () => {
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide());

        const refus = await request(app).delete(`/api/clients/${creation.body.id}`).set('Authorization', `Bearer ${token}`);
        expect(refus.status).toBe(403);

        const adminToken = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const suppression = await request(app).delete(`/api/clients/${creation.body.id}`).set('Authorization', `Bearer ${adminToken}`);
        expect(suppression.status).toBe(204);

        const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${token}`);
        expect(liste.body).toHaveLength(0);
    });

    test('génère un PIN portail à usage unique', async () => {
        const creation = await request(app).post('/api/clients').set('Authorization', `Bearer ${token}`).send(payloadClientValide());

        const res = await request(app).post(`/api/clients/${creation.body.id}/pin`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.pin).toMatch(/^\d{6}$/);
        expect(res.body.client.nom).toBe('Awa Diouf');
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Audit systèmes 2026-08-11 (item #13) : dépôt GPS (routing.js) et en-tête de facture PDF
// (facturePdf.js) étaient codés en dur sur Ferme Massla pour toutes les fermes clientes.
describe('paramètres — informations de la ferme (dépôt GPS + en-tête facture)', () => {
    let pool;
    let app;
    let tenantId;
    let tokenAdmin;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test');
        app = buildApp(pool, ['parametres-ferme']);
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test("tant que rien n'est configuré, les champs sont nuls", async () => {
        const res = await request(app).get('/api/parametres-ferme').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(200);
        expect(res.body.nom).toBe('Ferme Test');
        expect(res.body.adresse).toBeNull();
        expect(res.body.gps_lat).toBeNull();
    });

    test('enregistre adresse, téléphone et coordonnées GPS', async () => {
        const res = await request(app)
            .put('/api/parametres-ferme')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ adresse: 'Route de Diamniadio', telephone: '77 123 45 67', gps_lat: '14.7247', gps_lng: '-17.1875' });
        expect(res.status).toBe(200);
        expect(res.body.adresse).toBe('Route de Diamniadio');
        expect(Number(res.body.gps_lat)).toBeCloseTo(14.7247);
        expect(Number(res.body.gps_lng)).toBeCloseTo(-17.1875);

        const consultation = await request(app).get('/api/parametres-ferme').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(consultation.body.telephone).toBe('77 123 45 67');
    });

    test('rejette une latitude hors intervalle', async () => {
        const res = await request(app)
            .put('/api/parametres-ferme')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ gps_lat: '200', gps_lng: '-17.1875' });
        expect(res.status).toBe(400);
    });

    test('rejette une latitude renseignée sans longitude (dépôt à moitié configuré)', async () => {
        const res = await request(app)
            .put('/api/parametres-ferme')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ gps_lat: '14.7247', gps_lng: '' });
        expect(res.status).toBe(400);
    });

    test('un comptable (non admin) ne peut pas accéder à ces réglages', async () => {
        const tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        const res = await request(app).get('/api/parametres-ferme').set('Authorization', `Bearer ${tokenComptable}`);
        expect(res.status).toBe(403);
    });

    test("les informations d'une organisation ne sont jamais visibles depuis une autre (isolation)", async () => {
        await request(app)
            .put('/api/parametres-ferme')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ adresse: 'Adresse Ferme A', gps_lat: '14.1', gps_lng: '-17.1' });

        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const tokenAutreAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: autreTenantId });

        const res = await request(app).get('/api/parametres-ferme').set('Authorization', `Bearer ${tokenAutreAdmin}`);
        expect(res.body.adresse).toBeNull();
        expect(res.body.nom).toBe('Autre Ferme');
    });
});

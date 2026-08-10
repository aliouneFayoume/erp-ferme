const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('paramètres — identifiants WhatsApp par organisation', () => {
    let pool;
    let app;
    let tenantId;
    let tokenAdmin;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['parametres-whatsapp']);
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test("tant que rien n'est configuré, l'état est explicitement non configuré", async () => {
        const res = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(200);
        expect(res.body.configure).toBe(false);
        expect(res.body.estPlateforme).toBe(false);
    });

    test('enregistre les identifiants puis ne les réaffiche jamais en clair', async () => {
        const enregistrement = await request(app)
            .put('/api/parametres-whatsapp')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ access_token: 'jeton-secret', phone_number_id: '123456789' });
        expect(enregistrement.status).toBe(200);
        expect(enregistrement.body.configure).toBe(true);
        expect(JSON.stringify(enregistrement.body)).not.toContain('jeton-secret');

        const consultation = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(consultation.body.configure).toBe(true);

        const row = await pool.query(`SELECT access_token_chiffre FROM organisation_whatsapp_config WHERE tenant_id = $1`, [tenantId]);
        expect(row.rows[0].access_token_chiffre).not.toContain('jeton-secret');
    });

    test('rejette un enregistrement avec un identifiant manquant', async () => {
        const res = await request(app)
            .put('/api/parametres-whatsapp')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ access_token: '', phone_number_id: '123456789' });
        expect(res.status).toBe(400);
    });

    test('un comptable (non admin) ne peut pas accéder aux réglages WhatsApp', async () => {
        const tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        const res = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenComptable}`);
        expect(res.status).toBe(403);
    });

    test("les identifiants d'une organisation ne sont jamais visibles depuis une autre (isolation)", async () => {
        await request(app)
            .put('/api/parametres-whatsapp')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ access_token: 'jeton-A', phone_number_id: '111' });

        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const tokenAutreAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: autreTenantId });

        const res = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAutreAdmin}`);
        expect(res.body.configure).toBe(false);
    });

    test("pour Ferme Massla (est_plateforme), la page indique que c'est déjà géré au niveau plateforme", async () => {
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [tenantId]);

        const res = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAdmin}`);

        expect(res.status).toBe(200);
        expect(res.body.estPlateforme).toBe(true);
        expect(res.body.configure).toBe(true);
    });
});

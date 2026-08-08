const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('paramètres — agrégateur de paiement PayDunya par organisation', () => {
    let pool;
    let app;
    let tenantId;
    let tokenAdmin;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['parametres-paiement']);
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test("tant que rien n'est configuré, l'état est explicitement non configuré", async () => {
        const res = await request(app).get('/api/parametres-paiement/paiement').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(200);
        expect(res.body.configure).toBe(false);
    });

    test('enregistre les identifiants puis ne les réaffiche jamais en clair', async () => {
        const enregistrement = await request(app)
            .put('/api/parametres-paiement/paiement')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ mode: 'test', master_key: 'mk-secret', private_key: 'pk-secret', public_key: 'pub-secret', token: 'tok-secret' });
        expect(enregistrement.status).toBe(200);
        expect(enregistrement.body.configure).toBe(true);
        expect(enregistrement.body.mode).toBe('test');
        expect(JSON.stringify(enregistrement.body)).not.toContain('secret');

        const consultation = await request(app).get('/api/parametres-paiement/paiement').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(consultation.body).toEqual({ configure: true, mode: 'test' });

        // Les clés sont bien chiffrées en base, jamais en clair.
        const row = await pool.query(`SELECT master_key_chiffre FROM organisation_paydunya_config WHERE tenant_id = $1`, [tenantId]);
        expect(row.rows[0].master_key_chiffre).not.toContain('mk-secret');
    });

    test('rejette un enregistrement avec un identifiant manquant', async () => {
        const res = await request(app)
            .put('/api/parametres-paiement/paiement')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ mode: 'test', master_key: 'mk', private_key: '', public_key: 'pub', token: 'tok' });
        expect(res.status).toBe(400);
    });

    test('rejette un mode invalide', async () => {
        const res = await request(app)
            .put('/api/parametres-paiement/paiement')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ mode: 'sandbox-xyz', master_key: 'mk', private_key: 'pk', public_key: 'pub', token: 'tok' });
        expect(res.status).toBe(400);
    });

    test('un comptable (non admin) ne peut pas accéder aux réglages de paiement', async () => {
        const tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        const res = await request(app).get('/api/parametres-paiement/paiement').set('Authorization', `Bearer ${tokenComptable}`);
        expect(res.status).toBe(403);
    });

    test("les identifiants d'une organisation ne sont jamais visibles depuis une autre (isolation)", async () => {
        await request(app)
            .put('/api/parametres-paiement/paiement')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ mode: 'live', master_key: 'mk-A', private_key: 'pk-A', public_key: 'pub-A', token: 'tok-A' });

        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const tokenAutreAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: autreTenantId });

        const res = await request(app).get('/api/parametres-paiement/paiement').set('Authorization', `Bearer ${tokenAutreAdmin}`);
        expect(res.body.configure).toBe(false);
    });
});

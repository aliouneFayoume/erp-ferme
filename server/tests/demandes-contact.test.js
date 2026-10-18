const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

jest.mock('../src/whatsapp');
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn(),
}));

describe('plateforme — demandes du formulaire de contact public', () => {
    let pool;
    let app;
    let tokenSuperviseur;
    let tokenAdminNormal;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        const tenant = await creerOrganisation(pool, 'Ferme A');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenant, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenant, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });
    afterEach(async () => {
        await pool.end();
    });

    const creer = async (nom, traitee = false) =>
        (await pool.query(
            `INSERT INTO demandes_contact (nom, email, whatsapp, source, traitee) VALUES ($1, 'a@test.sn', '+221770000000', 'essai', $2) RETURNING id`,
            [nom, traitee]
        )).rows[0].id;
    const auth = (r, t) => r.set('Authorization', `Bearer ${t}`);

    test('le superviseur liste les demandes, les non traitées en premier', async () => {
        await creer('Déjà rappelée', true);
        await creer('À rappeler');
        const res = await auth(request(app).get('/api/plateforme/demandes-contact'), tokenSuperviseur);
        expect(res.status).toBe(200);
        expect(res.body.map((d) => d.nom)).toEqual(['À rappeler', 'Déjà rappelée']);
    });

    test('un admin sans le flag superviseur est refusé', async () => {
        expect((await auth(request(app).get('/api/plateforme/demandes-contact'), tokenAdminNormal)).status).toBe(403);
        const id = await creer('X');
        expect((await auth(request(app).put(`/api/plateforme/demandes-contact/${id}`), tokenAdminNormal).send({ traitee: true })).status).toBe(403);
    });

    test('marquer traitée / rouvrir une demande, tracé dans le journal', async () => {
        const id = await creer('À rappeler');
        const res = await auth(request(app).put(`/api/plateforme/demandes-contact/${id}`), tokenSuperviseur).send({ traitee: true });
        expect(res.status).toBe(200);
        expect(res.body.traitee).toBe(true);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'demandes_contact'`)).rows[0].n).toBe(1);

        const rouvre = await auth(request(app).put(`/api/plateforme/demandes-contact/${id}`), tokenSuperviseur).send({ traitee: false });
        expect(rouvre.body.traitee).toBe(false);
    });

    test('demande inconnue : 404', async () => {
        const res = await auth(request(app).put('/api/plateforme/demandes-contact/9999'), tokenSuperviseur).send({ traitee: true });
        expect(res.status).toBe(404);
    });
});

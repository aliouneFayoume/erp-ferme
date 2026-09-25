const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Jamais de vrai envoi d'email de vérification en test.
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));

// Constaté en démo (2026-09-24) : un email déjà pris renvoyait une erreur générique « (email déjà utilisé ?) ».
// L'adresse est unique sur TOUTE la plateforme : le message doit le dire, avec un statut 409 (pas une panne 500).
describe('utilisateurs : email déjà utilisé', () => {
    let pool, app, tokenAdminA, tenantA, tenantB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenAdminA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['utilisateurs']);
    });

    afterEach(async () => {
        await pool.end();
    });

    const creer = (email) =>
        request(app)
            .post('/api/utilisateurs')
            .set('Authorization', `Bearer ${tokenAdminA}`)
            .send({ nom_complet: 'Nouvel Employé', email, password: 'Poisson2026!ab', role: 'comptable' });

    test('un email déjà pris dans une AUTRE ferme est refusé avec un message précis (409)', async () => {
        await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantB });
        const { rows } = await pool.query(`SELECT email FROM utilisateurs WHERE tenant_id = $1`, [tenantB]);

        const res = await creer(rows[0].email);

        expect(res.status).toBe(409);
        expect(res.body.erreur).toMatch(/déjà utilisée sur Massla/);
    });

    test('un email neuf est accepté', async () => {
        const res = await creer(`nouveau-${Date.now()}@test.sn`);
        expect(res.status).toBe(201);
    });

    test('changer l’email d’un utilisateur vers une adresse déjà prise donne le même message précis (409)', async () => {
        await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantB });
        const prise = (await pool.query(`SELECT email FROM utilisateurs WHERE tenant_id = $1`, [tenantB])).rows[0].email;
        const cree = await creer(`a-modifier-${Date.now()}@test.sn`);

        const res = await request(app)
            .put(`/api/utilisateurs/${cree.body.id}`)
            .set('Authorization', `Bearer ${tokenAdminA}`)
            .send({ email: prise, role: 'comptable' });

        expect(res.status).toBe(409);
        expect(res.body.erreur).toMatch(/déjà utilisée sur Massla/);
    });
});

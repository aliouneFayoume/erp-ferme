const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken, creerClient } = require('./helpers/testApp');

async function creerTicket(pool, tenantId, clientId, overrides = {}) {
    const t = { sujet: 'Ticket Test', statut: 'OUVERT', ...overrides };
    const res = await pool.query(
        `INSERT INTO tickets (tenant_id, client_id, sujet, statut) VALUES ($1, $2, $3, $4) RETURNING *`,
        [tenantId, clientId, t.sujet, t.statut]
    );
    return res.rows[0];
}

describe('plateforme — vue support multi-fermes', () => {
    let pool;
    let app;
    let tenantA;
    let tenantB;
    let tokenSuperviseur;
    let tokenAdminNormal;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un admin sans le flag superviseur reçoit 403 sur toutes les routes plateforme', async () => {
        const res = await request(app).get('/api/plateforme/organisations').set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(res.status).toBe(403);
    });

    test('le superviseur voit toutes les organisations avec leurs compteurs', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA, telephone: '+221771110001' });
        const clientB = await creerClient(pool, { tenant_id: tenantB, telephone: '+221771110002' });
        await creerTicket(pool, tenantA, clientA.id, { statut: 'OUVERT' });
        await creerTicket(pool, tenantA, clientA.id, { statut: 'RESOLU' });
        await creerTicket(pool, tenantB, clientB.id, { statut: 'OUVERT' });

        const res = await request(app).get('/api/plateforme/organisations').set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        const orgA = res.body.find((o) => o.id === tenantA);
        const orgB = res.body.find((o) => o.id === tenantB);
        expect(orgA).toBeTruthy();
        expect(orgB).toBeTruthy();
        expect(Number(orgA.tickets_ouverts)).toBe(1);
        expect(Number(orgA.tickets_total)).toBe(2);
        expect(Number(orgB.tickets_ouverts)).toBe(1);
    });

    test('le superviseur voit les tickets de toutes les organisations, pas seulement la sienne', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA, telephone: '+221771110003' });
        const clientB = await creerClient(pool, { tenant_id: tenantB, telephone: '+221771110004' });
        await creerTicket(pool, tenantA, clientA.id, { sujet: 'Souci Ferme A' });
        await creerTicket(pool, tenantB, clientB.id, { sujet: 'Souci Ferme B' });

        const res = await request(app).get('/api/plateforme/tickets').set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        const sujets = res.body.map((t) => t.sujet);
        expect(sujets).toContain('Souci Ferme A');
        expect(sujets).toContain('Souci Ferme B');
        expect(res.body.find((t) => t.sujet === 'Souci Ferme B').organisation_nom).toBe('Ferme B');
    });

    test("se connecter en tant qu'admin d'une autre organisation renvoie un token valide pour CETTE organisation, et journalise l'action dans son audit", async () => {
        const emailAdminB = `admin-cible-${Date.now()}@test.sn`;
        await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB, nom_complet: 'Admin Ferme B' });
        // creerUtilisateurEtToken ne renvoie qu'un token, on relit l'utilisateur créé pour son email réel.
        const adminB = await pool.query(`SELECT id, email FROM utilisateurs WHERE tenant_id = $1 AND role_id = (SELECT id FROM roles WHERE nom = 'admin') LIMIT 1`, [tenantB]);

        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/se-connecter-admin`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.utilisateur.tenant_id).toBe(tenantB);
        expect(res.body.utilisateur.id).toBe(adminB.rows[0].id);

        const audit = await pool.query(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = 'CONNEXION_SUPPORT'`, [tenantB]);
        expect(audit.rows).toHaveLength(1);
    });

    test("se connecter à une organisation sans administrateur actif renvoie 404", async () => {
        const tenantVide = await creerOrganisation(pool, 'Ferme Vide');

        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantVide}/se-connecter-admin`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(404);
    });
});

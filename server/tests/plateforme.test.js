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

describe('plateforme — facturation SaaS', () => {
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

    test('un admin sans le flag superviseur reçoit 403 sur les routes de facturation SaaS', async () => {
        const res = await request(app).get('/api/plateforme/factures-saas').set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(res.status).toBe(403);
    });

    test('configurer un abonnement pour la première fois génère automatiquement la facture de configuration', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance', 'logistique'], montantMensuel: 55000, fraisConfiguration: 75000 });

        expect(res.status).toBe(200);
        expect(res.body.frais_configuration_facture).toBe(true);

        const factures = await pool.query(`SELECT * FROM factures_saas WHERE tenant_id = $1 AND type = 'CONFIGURATION'`, [tenantA]);
        expect(factures.rows).toHaveLength(1);
        expect(Number(factures.rows[0].montant)).toBe(75000);
        expect(factures.rows[0].statut).toBe('A_PAYER');
    });

    test('reconfigurer un abonnement existant ne régénère jamais la facture de configuration', async () => {
        await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance'], montantMensuel: 40000, fraisConfiguration: 75000 });

        const res2 = await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance', 'support'], montantMensuel: 45000 });

        expect(res2.status).toBe(200);
        expect(Number(res2.body.montant_mensuel)).toBe(45000);

        const factures = await pool.query(`SELECT * FROM factures_saas WHERE tenant_id = $1 AND type = 'CONFIGURATION'`, [tenantA]);
        expect(factures.rows).toHaveLength(1);
    });

    test('générer les factures du mois crée une échéance par organisation active, jamais pour les inactives, et reste idempotent', async () => {
        await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance'], montantMensuel: 40000 });
        await request(app)
            .put(`/api/plateforme/organisations/${tenantB}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['support'], montantMensuel: 30000, actif: false });

        const gen1 = await request(app).post('/api/plateforme/factures-saas/generer').set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(gen1.status).toBe(200);
        expect(gen1.body.creees).toBe(1);

        const factures = await pool.query(`SELECT * FROM factures_saas WHERE type = 'ABONNEMENT'`);
        expect(factures.rows).toHaveLength(1);
        expect(factures.rows[0].tenant_id).toBe(tenantA);

        const gen2 = await request(app).post('/api/plateforme/factures-saas/generer').set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(gen2.body.creees).toBe(0);
        expect(gen2.body.deja_generees).toBe(1);
        const facturesApres = await pool.query(`SELECT * FROM factures_saas WHERE type = 'ABONNEMENT'`);
        expect(facturesApres.rows).toHaveLength(1);
    });

    test('marquer une facture comme payée enregistre la date et le moyen de paiement', async () => {
        await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance'], montantMensuel: 40000, fraisConfiguration: 75000 });
        const factures = await pool.query(`SELECT id FROM factures_saas WHERE tenant_id = $1`, [tenantA]);
        const factureId = factures.rows[0].id;

        const res = await request(app)
            .put(`/api/plateforme/factures-saas/${factureId}`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ statut: 'PAYEE', methodePaiement: 'WAVE' });

        expect(res.status).toBe(200);
        expect(res.body.statut).toBe('PAYEE');
        expect(res.body.methode_paiement).toBe('WAVE');
        expect(res.body.date_paiement).toBeTruthy();
    });

    test('la liste des factures SaaS inclut le nom de la ferme', async () => {
        await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance'], montantMensuel: 40000, fraisConfiguration: 75000 });

        const res = await request(app).get('/api/plateforme/factures-saas').set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].organisation_nom).toBe('Ferme A');
    });
});

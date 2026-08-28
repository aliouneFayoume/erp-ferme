const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken, creerClient } = require('./helpers/testApp');

jest.mock('../src/whatsapp');
const { envoyerMessageWhatsapp } = require('../src/whatsapp');

// Durcissement sécurité (migration-20) : creerFerme.js (utilisé par POST /organisations) refuse de
// créer un compte si l'envoi de l'email de vérification n'est pas configuré — jamais de vrai appel
// réseau vers Resend en test.
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn(),
}));
const { envoyerEmailRappelSaas } = require('../src/email');

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

    // Audit sécurité 2026-08-11 (E4) : contrepartie de se-connecter-admin, journalise la fin d'une
    // session d'impersonation.
    test('fin-session-support journalise la fin de session avec un token d\'impersonation valide', async () => {
        await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB, nom_complet: 'Admin Ferme B' });

        const connexion = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/se-connecter-admin`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);
        const tokenImpersonation = connexion.body.token;

        const res = await request(app)
            .post('/api/plateforme/fin-session-support')
            .set('Authorization', `Bearer ${tokenImpersonation}`);

        expect(res.status).toBe(204);
        const audit = await pool.query(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = 'FIN_SUPPORT'`, [tenantB]);
        expect(audit.rows).toHaveLength(1);
    });

    test('fin-session-support refuse un token normal (non-impersonation)', async () => {
        const res = await request(app)
            .post('/api/plateforme/fin-session-support')
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(400);
        const audit = await pool.query(`SELECT * FROM audit_logs WHERE action = 'FIN_SUPPORT'`);
        expect(audit.rows).toHaveLength(0);
    });

    test("se connecter à une organisation sans administrateur actif renvoie 404", async () => {
        const tenantVide = await creerOrganisation(pool, 'Ferme Vide');

        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantVide}/se-connecter-admin`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(404);
    });
});

describe('plateforme — création directe de ferme', () => {
    let pool;
    let app;
    let tenantA;
    let tokenSuperviseur;
    let tokenAdminNormal;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    function payloadValide(overrides = {}) {
        return {
            nomFerme: 'Ferme Créée Directement',
            secteurs: [{ nom: 'Avicole', suiviRecolte: false }],
            adminNomComplet: 'Nouvel Admin',
            adminEmail: `nouvel-admin-${Date.now()}@test.sn`,
            adminPassword: 'Motdepasse123!',
            ...overrides,
        };
    }

    test('le superviseur peut créer une ferme directement, sans code d\'invitation', async () => {
        const res = await request(app)
            .post('/api/plateforme/organisations')
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send(payloadValide());

        expect(res.status).toBe(201);
        expect(res.body.tenantId).toBeTruthy();

        const org = await pool.query(`SELECT * FROM organisations WHERE id = $1`, [res.body.tenantId]);
        expect(org.rows[0].nom).toBe('Ferme Créée Directement');
        const admin = await pool.query(`SELECT role_id FROM utilisateurs WHERE id = $1`, [res.body.admin.id]);
        expect(admin.rows).toHaveLength(1);

        // Attribué au superviseur qui a cliqué "créer", pas au nouvel admin (contrairement à
        // l'inscription self-service, où personne d'autre n'a agi).
        const audit = await pool.query(`SELECT utilisateur_id FROM audit_logs WHERE tenant_id = $1 AND action = 'CREATE'`, [res.body.tenantId]);
        expect(audit.rows[0].utilisateur_id).not.toBe(res.body.admin.id);
    });

    test('un admin sans le flag superviseur ne peut pas créer de ferme directement', async () => {
        const res = await request(app)
            .post('/api/plateforme/organisations')
            .set('Authorization', `Bearer ${tokenAdminNormal}`)
            .send(payloadValide());

        expect(res.status).toBe(403);
    });

    test('rejette une création sans secteur', async () => {
        const res = await request(app)
            .post('/api/plateforme/organisations')
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send(payloadValide({ secteurs: [] }));

        expect(res.status).toBe(400);
    });

    test('rejette un email admin déjà utilisé', async () => {
        const email = `doublon-plateforme-${Date.now()}@test.sn`;
        await request(app).post('/api/plateforme/organisations').set('Authorization', `Bearer ${tokenSuperviseur}`).send(payloadValide({ adminEmail: email }));

        const res2 = await request(app)
            .post('/api/plateforme/organisations')
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send(payloadValide({ adminEmail: email, nomFerme: 'Autre Ferme' }));

        expect(res2.status).toBe(409);
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

describe('plateforme — suppression de ferme', () => {
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

    test('le superviseur peut supprimer (soft delete) une autre organisation', async () => {
        const res = await request(app).delete(`/api/plateforme/organisations/${tenantB}`).set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(204);

        const org = await pool.query(`SELECT deleted_at FROM organisations WHERE id = $1`, [tenantB]);
        expect(org.rows[0].deleted_at).toBeTruthy();

        const liste = await request(app).get('/api/plateforme/organisations').set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(liste.body.find((o) => o.id === tenantB)).toBeUndefined();
    });

    test('le superviseur ne peut pas supprimer sa propre organisation', async () => {
        const res = await request(app).delete(`/api/plateforme/organisations/${tenantA}`).set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(400);
    });

    test('supprimer une organisation déjà supprimée renvoie 404', async () => {
        await request(app).delete(`/api/plateforme/organisations/${tenantB}`).set('Authorization', `Bearer ${tokenSuperviseur}`);
        const res2 = await request(app).delete(`/api/plateforme/organisations/${tenantB}`).set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res2.status).toBe(404);
    });

    test('un admin sans le flag superviseur ne peut pas supprimer de ferme', async () => {
        const res = await request(app).delete(`/api/plateforme/organisations/${tenantB}`).set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(res.status).toBe(403);
    });
});

describe('plateforme — sous-domaines (slug)', () => {
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
        await pool.query(`UPDATE organisations SET slug = 'ferme-a' WHERE id = $1`, [tenantA]);
        await pool.query(`UPDATE organisations SET slug = 'ferme-b' WHERE id = $1`, [tenantB]);
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('le superviseur peut modifier le sous-domaine d\'une ferme', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/${tenantB}/slug`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ slug: 'nouveau-nom' });

        expect(res.status).toBe(200);
        expect(res.body.slug).toBe('nouveau-nom');
        const org = await pool.query(`SELECT slug FROM organisations WHERE id = $1`, [tenantB]);
        expect(org.rows[0].slug).toBe('nouveau-nom');
    });

    test('rejette un sous-domaine déjà utilisé par une autre ferme', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/${tenantB}/slug`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ slug: 'ferme-a' });

        expect(res.status).toBe(409);
    });

    test('rejette un format invalide (espaces, caractères spéciaux, tiret en bordure)', async () => {
        const invalides = ['ferme a', '-ferme-c', 'ferme-c-', '', 'ferme_c', 'ferme@c'];
        for (const slug of invalides) {
            const res = await request(app)
                .put(`/api/plateforme/organisations/${tenantB}/slug`)
                .set('Authorization', `Bearer ${tokenSuperviseur}`)
                .send({ slug });
            expect(res.status).toBe(400);
        }
    });

    test('un admin sans le flag superviseur ne peut pas modifier de sous-domaine', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/${tenantB}/slug`)
            .set('Authorization', `Bearer ${tokenAdminNormal}`)
            .send({ slug: 'nouveau-nom' });
        expect(res.status).toBe(403);
    });

    test('renvoie 404 pour une ferme inexistante', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/999999/slug`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ slug: 'nouveau-nom' });
        expect(res.status).toBe(404);
    });
});

describe('plateforme — ajout de secteur à une ferme existante', () => {
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
        await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Avicole')`, [tenantB]);
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('le superviseur voit les secteurs existants d\'une autre organisation', async () => {
        const res = await request(app).get(`/api/plateforme/organisations/${tenantB}/secteurs`).set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(200);
        expect(res.body.map((s) => s.nom)).toEqual(['Avicole']);
    });

    test('le superviseur peut ajouter un secteur à une autre organisation', async () => {
        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/secteurs`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ nom: 'Piscicole', suiviRecolte: false });

        expect(res.status).toBe(201);
        expect(res.body.nom).toBe('Piscicole');

        const secteurs = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1 ORDER BY nom`, [tenantB]);
        expect(secteurs.rows.map((s) => s.nom)).toEqual(['Avicole', 'Piscicole']);
    });

    test('rejette un secteur en double (insensible à la casse)', async () => {
        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/secteurs`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ nom: 'avicole' });
        expect(res.status).toBe(409);
    });

    test('rejette un nom de secteur vide', async () => {
        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/secteurs`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ nom: '   ' });
        expect(res.status).toBe(400);
    });

    // Audit sécurité 2026-08-11 (M2) : voir le test équivalent dans inscription.test.js.
    test('rejette un nom de secteur contenant des caractères HTML/script (XSS)', async () => {
        const res = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/secteurs`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ nom: '<script>alert(1)</script>' });
        expect(res.status).toBe(400);
        const secteurs = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [tenantB]);
        expect(secteurs.rows.map((s) => s.nom)).toEqual(['Avicole']);
    });

    test('un admin sans le flag superviseur ne peut ni lire ni ajouter de secteur', async () => {
        const resLecture = await request(app).get(`/api/plateforme/organisations/${tenantB}/secteurs`).set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(resLecture.status).toBe(403);

        const resAjout = await request(app)
            .post(`/api/plateforme/organisations/${tenantB}/secteurs`)
            .set('Authorization', `Bearer ${tokenAdminNormal}`)
            .send({ nom: 'Piscicole' });
        expect(resAjout.status).toBe(403);
    });
});

describe('plateforme — relance de facture SaaS par WhatsApp', () => {
    let pool;
    let app;
    let tenantA;
    let tokenSuperviseur;
    let tokenAdminNormal;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerFactureAvecTelephone(telephone) {
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel, telephone_contact) VALUES ($1, 40000, $2)`,
            [tenantA, telephone]
        );
        const facture = await pool.query(
            `INSERT INTO factures_saas (tenant_id, type, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', 40000, 'EN_RETARD', CURRENT_DATE) RETURNING id`,
            [tenantA]
        );
        return facture.rows[0].id;
    }

    test('envoie un rappel WhatsApp au numéro de contact configuré', async () => {
        envoyerMessageWhatsapp.mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
        const factureId = await creerFactureAvecTelephone('+221771234567');

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        expect(res.body.envoye).toBe(true);
        expect(envoyerMessageWhatsapp).toHaveBeenCalledWith('+221771234567');

        const audit = await pool.query(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = 'RAPPEL_WHATSAPP'`, [tenantA]);
        expect(audit.rows).toHaveLength(1);
    });

    test("rejette si aucun numéro de contact n'est configuré", async () => {
        await pool.query(`INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel) VALUES ($1, 40000)`, [tenantA]);
        const facture = await pool.query(
            `INSERT INTO factures_saas (tenant_id, type, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', 40000, 'A_PAYER', CURRENT_DATE) RETURNING id`,
            [tenantA]
        );

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${facture.rows[0].id}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(400);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });

    test('renvoie 404 pour une facture inexistante', async () => {
        const res = await request(app)
            .post(`/api/plateforme/factures-saas/999999/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(404);
    });

    test("propage un message d'erreur clair si l'envoi WhatsApp échoue", async () => {
        envoyerMessageWhatsapp.mockRejectedValue(new Error('Jeton invalide ou expiré'));
        const factureId = await creerFactureAvecTelephone('+221771234567');

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(500);
        expect(res.body.erreur).toBe('Jeton invalide ou expiré');
    });

    test('un admin sans le flag superviseur ne peut pas envoyer de rappel', async () => {
        const factureId = await creerFactureAvecTelephone('+221771234567');
        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(res.status).toBe(403);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });

    test('le numéro de contact WhatsApp est bien enregistré via PUT abonnement-saas', async () => {
        const res = await request(app)
            .put(`/api/plateforme/organisations/${tenantA}/abonnement-saas`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`)
            .send({ modulesActifs: ['finance'], montantMensuel: 40000, telephoneContact: '+221781112233' });

        expect(res.status).toBe(200);
        expect(res.body.telephone_contact).toBe('+221781112233');
    });
});

describe('plateforme — relance de facture SaaS par email', () => {
    let pool;
    let app;
    let tenantA;
    let tokenSuperviseur;
    let tokenAdminNormal;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerFacture() {
        const facture = await pool.query(
            `INSERT INTO factures_saas (tenant_id, type, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', 40000, 'EN_RETARD', CURRENT_DATE) RETURNING id`,
            [tenantA]
        );
        return facture.rows[0].id;
    }

    test('envoie un rappel email à tous les administrateurs actifs de la ferme', async () => {
        envoyerEmailRappelSaas.mockResolvedValue({});
        const factureId = await creerFacture();
        const emailsRes = await pool.query('SELECT email FROM utilisateurs WHERE tenant_id = $1', [tenantA]);
        const emailsAttendus = emailsRes.rows.map((r) => r.email).sort();

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(200);
        expect(res.body.envoye).toBe(true);
        expect(envoyerEmailRappelSaas).toHaveBeenCalledTimes(1);
        const [emailsEnvoyes] = envoyerEmailRappelSaas.mock.calls[0];
        expect(emailsEnvoyes.slice().sort()).toEqual(emailsAttendus);
    });

    test("renvoie 400 si aucun administrateur actif n'existe pour la ferme ciblée", async () => {
        const tenantB = await creerOrganisation(pool, 'Ferme B');
        const tokenSuperviseurExterne = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB, estSuperviseurPlateforme: true });
        await pool.query(`UPDATE utilisateurs SET actif = FALSE WHERE tenant_id = $1`, [tenantA]);
        const factureId = await creerFacture();

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
            .set('Authorization', `Bearer ${tokenSuperviseurExterne}`);

        expect(res.status).toBe(400);
        expect(envoyerEmailRappelSaas).not.toHaveBeenCalled();
    });

    test('renvoie 404 pour une facture inexistante', async () => {
        const res = await request(app)
            .post(`/api/plateforme/factures-saas/999999/rappel-email`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(404);
    });

    test("propage l'erreur si l'envoi échoue", async () => {
        envoyerEmailRappelSaas.mockRejectedValue(new Error('Intégration email non configurée (RESEND_API_KEY / RESEND_FROM_EMAIL manquants).'));
        const factureId = await creerFacture();

        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.status).toBe(500);
        expect(res.body.erreur).toBe('Intégration email non configurée (RESEND_API_KEY / RESEND_FROM_EMAIL manquants).');
    });

    test('un admin sans le flag superviseur ne peut pas envoyer de rappel', async () => {
        const factureId = await creerFacture();
        const res = await request(app)
            .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
            .set('Authorization', `Bearer ${tokenAdminNormal}`);
        expect(res.status).toBe(403);
        expect(envoyerEmailRappelSaas).not.toHaveBeenCalled();
    });
});

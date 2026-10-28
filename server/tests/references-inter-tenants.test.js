const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

// Jamais de vrai envoi d'email de vérification en test.
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));

// Les clés étrangères PostgreSQL ne passent PAS par la RLS : une ferme qui envoie dans le corps d'une requête l'identifiant
// d'une ligne d'une AUTRE ferme réussirait à s'y rattacher. Chaque route qui accepte un identifiant étranger doit donc
// vérifier elle-même qu'il appartient au tenant courant. Ces tests envoient un identifiant de la ferme B depuis la ferme A.
describe('références inter-tenants : un identifiant d’une autre ferme est refusé', () => {
    let pool, app, tenantA, tenantB, tokenAdminA, etrangers;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenAdminA = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantA });
        app = buildApp(pool, ['abonnements', 'logistique', 'intrants', 'utilisateurs', 'tickets', 'immobilisations', 'paie']);

        // Lignes de la ferme B (les « étrangers » vus depuis A).
        const secteurB = (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Secteur B') RETURNING id`, [tenantB])).rows[0].id;
        const clientB = await creerClient(pool, { tenant_id: tenantB });
        const produitB = await creerProduitAvecStock(pool, { tenant_id: tenantB, secteur_id: secteurB });
        const lotB = (await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut) VALUES ($1, $2, 'LOT-B', 10, CURRENT_DATE, 'EN_COURS') RETURNING id`,
            [tenantB, secteurB]
        )).rows[0].id;
        const fournisseurB = (await pool.query(`INSERT INTO fournisseurs (tenant_id, nom) VALUES ($1, 'Fournisseur B') RETURNING id`, [tenantB])).rows[0].id;
        await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantB });
        const livreurB = (await pool.query(`SELECT id FROM utilisateurs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [tenantB])).rows[0].id;
        etrangers = { secteurB, clientB, produitB, lotB, fournisseurB, livreurB };
    });

    afterEach(async () => {
        await pool.end();
    });

    const auth = (req) => req.set('Authorization', `Bearer ${tokenAdminA}`);
    const secteurA = async () => (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Secteur A') RETURNING id`, [tenantA])).rows[0].id;

    test('abonnements : client_id ou produit_id d’une autre ferme refusé, rien n’est créé', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA });
        const produitA = await creerProduitAvecStock(pool, { tenant_id: tenantA });

        const clientEtranger = await auth(request(app).post('/api/abonnements')).send({ client_id: etrangers.clientB.id, produit_id: produitA.id, jour_livraison: 'LUNDI' });
        const produitEtranger = await auth(request(app).post('/api/abonnements')).send({ client_id: clientA.id, produit_id: etrangers.produitB.id, jour_livraison: 'LUNDI' });

        expect(clientEtranger.status).toBe(400);
        expect(produitEtranger.status).toBe(400);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM abonnements`)).rows[0].n).toBe(0);
        // Le client de B ne doit pas non plus être marqué « abonné » par A.
        expect((await pool.query(`SELECT est_abonne FROM clients WHERE id = $1`, [etrangers.clientB.id])).rows[0].est_abonne).toBeFalsy();
    });

    test('abonnements : client et produit de la ferme restent acceptés', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA });
        const produitA = await creerProduitAvecStock(pool, { tenant_id: tenantA });
        const res = await auth(request(app).post('/api/abonnements')).send({ client_id: clientA.id, produit_id: produitA.id, jour_livraison: 'LUNDI' });
        expect(res.status).toBe(201);
    });

    test('logistique : livreur_id d’une autre ferme refusé, la commande ne passe pas en livraison', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA });
        const commande = (await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-REF', $2, 'PREPAREE', 1000) RETURNING id`,
            [tenantA, clientA.id]
        )).rows[0];

        const res = await auth(request(app).post('/api/logistique/livraisons')).send({ commande_id: commande.id, livreur_id: etrangers.livreurB, date_prevue: '2026-11-01' });

        expect(res.status).toBe(400);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM livraisons`)).rows[0].n).toBe(0);
        expect((await pool.query(`SELECT statut FROM commandes WHERE id = $1`, [commande.id])).rows[0].statut).toBe('PREPAREE');
    });

    test('intrants : secteur_id d’une autre ferme refusé à la création et à la modification', async () => {
        const creation = await auth(request(app).post('/api/intrants')).send({ nom: 'Maïs', unite: 'kg', secteur_id: etrangers.secteurB });
        expect(creation.status).toBe(400);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM intrants`)).rows[0].n).toBe(0);

        const valide = await auth(request(app).post('/api/intrants')).send({ nom: 'Maïs', unite: 'kg', secteur_id: await secteurA() });
        expect(valide.status).toBe(201);

        const modification = await auth(request(app).put(`/api/intrants/${valide.body.id}`)).send({ secteur_id: etrangers.secteurB });
        expect(modification.status).toBe(400);
        const apres = await pool.query(`SELECT secteur_id FROM intrants WHERE id = $1`, [valide.body.id]);
        expect(apres.rows[0].secteur_id).not.toBe(etrangers.secteurB);
    });

    test('intrants : sortie manuelle avec lot_id d’une autre ferme refusée, stock inchangé', async () => {
        const intrant = (await pool.query(
            `INSERT INTO intrants (tenant_id, nom, unite, quantite_stock) VALUES ($1, 'Aliment', 'kg', 100) RETURNING id`,
            [tenantA]
        )).rows[0];

        const res = await auth(request(app).post(`/api/intrants/${intrant.id}/sortie`)).send({ quantite: 10, lot_id: etrangers.lotB });

        expect(res.status).toBe(400);
        expect(Number((await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [intrant.id])).rows[0].quantite_stock)).toBe(100);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM mouvements_intrants`)).rows[0].n).toBe(0);
    });

    test('utilisateurs : secteur_id d’une autre ferme refusé pour un chef de production (création et modification)', async () => {
        const creation = await auth(request(app).post('/api/utilisateurs')).send({
            nom_complet: 'Chef Suspect', email: `chef-${Date.now()}@test.sn`, password: 'Poisson2026!ab', role: 'chef_prod', secteur_id: etrangers.secteurB,
        });
        expect(creation.status).toBe(400);

        const valide = await auth(request(app).post('/api/utilisateurs')).send({
            nom_complet: 'Chef Valide', email: `chef-ok-${Date.now()}@test.sn`, password: 'Poisson2026!ab', role: 'chef_prod', secteur_id: await secteurA(),
        });
        expect(valide.status).toBe(201);

        const modification = await auth(request(app).put(`/api/utilisateurs/${valide.body.id}`)).send({ role: 'chef_prod', secteur_id: etrangers.secteurB });
        expect(modification.status).toBe(400);
        const apres = await pool.query(`SELECT secteur_id FROM utilisateurs WHERE id = $1`, [valide.body.id]);
        expect(apres.rows[0].secteur_id).not.toBe(etrangers.secteurB);
    });

    test('tickets : assigne_a d’un utilisateur d’une autre ferme refusé', async () => {
        const clientA = await creerClient(pool, { tenant_id: tenantA });
        const ticket = (await pool.query(`INSERT INTO tickets (tenant_id, client_id, sujet) VALUES ($1, $2, 'Sujet') RETURNING id`, [tenantA, clientA.id])).rows[0];

        const res = await auth(request(app).put(`/api/tickets/${ticket.id}`)).send({ assigne_a: etrangers.livreurB });

        expect(res.status).toBe(400);
        expect((await pool.query(`SELECT assigne_a FROM tickets WHERE id = $1`, [ticket.id])).rows[0].assigne_a).toBeNull();
    });

    test('immobilisations : secteur_id ou fournisseur_id d’une autre ferme refusé (création et modification)', async () => {
        const secteurEtranger = await auth(request(app).post('/api/immobilisations')).send({ nom: 'Pompe', secteur_id: etrangers.secteurB });
        const fournisseurEtranger = await auth(request(app).post('/api/immobilisations')).send({ nom: 'Pompe', fournisseur_id: etrangers.fournisseurB });
        expect(secteurEtranger.status).toBe(400);
        expect(fournisseurEtranger.status).toBe(400);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM equipements`)).rows[0].n).toBe(0);

        const valide = await auth(request(app).post('/api/immobilisations')).send({ nom: 'Pompe' });
        expect(valide.status).toBe(201);
        const modification = await auth(request(app).put(`/api/immobilisations/${valide.body.id}`)).send({ fournisseur_id: etrangers.fournisseurB });
        expect(modification.status).toBe(400);
        const modifSecteur = await auth(request(app).put(`/api/immobilisations/${valide.body.id}`)).send({ secteur_id: etrangers.secteurB });
        expect(modifSecteur.status).toBe(400);
    });

    test('paie : secteur_id d’une autre ferme refusé pour un employé (création et modification)', async () => {
        const creation = await auth(request(app).post('/api/paie/employes')).send({ nom_complet: 'Employé', secteur_id: etrangers.secteurB });
        expect(creation.status).toBe(400);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM employes`)).rows[0].n).toBe(0);

        const valide = await auth(request(app).post('/api/paie/employes')).send({ nom_complet: 'Employé', secteur_id: await secteurA() });
        expect(valide.status).toBe(201);
        const modification = await auth(request(app).put(`/api/paie/employes/${valide.body.id}`)).send({ secteur_id: etrangers.secteurB });
        expect(modification.status).toBe(400);
    });
});

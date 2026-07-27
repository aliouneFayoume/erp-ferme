const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('commandes', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['commandes']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('commande B2C : réserve le pool B2C et applique le tarif prix_unitaire_b2c', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2b: 1000, prix_unitaire_b2c: 1500, quantite_disponible: 100 });

        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 10 }] });

        expect(res.status).toBe(201);
        expect(Number(res.body.montant_total)).toBe(15000);

        const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_disponible)).toBe(90);
        expect(Number(stock.rows[0].quantite_reservee_b2c)).toBe(10);
        expect(Number(stock.rows[0].quantite_reservee_b2b)).toBe(0);
    });

    test('commande B2B grossiste : utilise le tarif préférentiel et réserve le pool B2B', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2B', categorie_tarifaire: 'grossiste', limite_credit: 1000000 });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2b: 1000, prix_unitaire_grossiste: 800, quantite_disponible: 100 });

        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'comptable', tenant_id: tenantId })}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 5 }] });

        expect(res.status).toBe(201);
        expect(Number(res.body.montant_total)).toBe(4000);

        const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_reservee_b2b)).toBe(5);
        expect(Number(stock.rows[0].quantite_reservee_b2c)).toBe(0);
    });

    test("commande B2B bloquée si l'encours dépasse la limite de crédit, sans effet de bord", async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2B', limite_credit: 5000 });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2b: 1000, quantite_disponible: 100 });

        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 10 }] });

        expect(res.status).toBe(403);

        // Aucune commande/facture ne doit avoir été créée pour ce client (transaction rejetée).
        const commandes = await pool.query(`SELECT * FROM commandes WHERE client_id = $1`, [client.id]);
        expect(commandes.rows).toHaveLength(0);

        const clientApres = await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id]);
        expect(Number(clientApres.rows[0].solde_encours)).toBe(0);

        // Note : on ne vérifie PAS ici que la réservation de stock a bien été annulée par le ROLLBACK.
        // pg-mem (simulation) ne défait pas les UPDATE lors d'un ROLLBACK (limitation connue de la
        // librairie, vérifiée indépendamment) — contrairement à un vrai PostgreSQL, où ROLLBACK annule
        // systématiquement toute la transaction. Ce point ne peut donc être vérifié que manuellement
        // (ou via un test d'intégration) contre une vraie base Postgres.
    });

    test('commande refusée si stock insuffisant, sans effet de bord', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, quantite_disponible: 3 });

        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 10 }] });

        expect(res.status).toBe(409);
        const stock = await pool.query(`SELECT quantite_disponible FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_disponible)).toBe(3);
    });

    test('annulation B2B : libère le stock réservé et réduit l\'encours client', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2B', limite_credit: 1000000 });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2b: 1000, quantite_disponible: 100 });

        const admin = await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId });
        const creation = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${admin}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 10 }] });
        const commandeId = creation.body.id;

        const annulation = await request(app)
            .put(`/api/commandes/${commandeId}/statut`)
            .set('Authorization', `Bearer ${admin}`)
            .send({ statut: 'ANNULEE' });

        expect(annulation.status).toBe(200);

        const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_disponible)).toBe(100);
        expect(Number(stock.rows[0].quantite_reservee_b2b)).toBe(0);

        const clientApres = await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id]);
        expect(Number(clientApres.rows[0].solde_encours)).toBe(0);
    });

    test('impossible d\'annuler une commande déjà livrée', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, quantite_disponible: 100 });
        const admin = await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId });

        const creation = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${admin}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 5 }] });
        const commandeId = creation.body.id;

        await request(app).put(`/api/commandes/${commandeId}/statut`).set('Authorization', `Bearer ${admin}`).send({ statut: 'LIVREE' });

        const annulation = await request(app)
            .put(`/api/commandes/${commandeId}/statut`)
            .set('Authorization', `Bearer ${admin}`)
            .send({ statut: 'ANNULEE' });

        expect(annulation.status).toBe(400);
    });

    test('RBAC : un livreur ne peut pas créer de commande', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId });

        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'livreur', tenant_id: tenantId })}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 1 }] });

        expect(res.status).toBe(403);
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

// Correctifs d'audit sécurité : transitions de statut, quantités, idempotence de la livraison, PIN client.
describe('sécurité commandes / abonnements / logistique / clients', () => {
    let pool;
    let app;
    let tenantId;
    let admin;

    beforeEach(async () => {
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['commandes', 'abonnements', 'logistique', 'clients']);
        admin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerCommande(typeClient = 'B2B', quantite = 10) {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: typeClient, limite_credit: 1000000 });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2b: 1000, prix_unitaire_b2c: 1000, quantite_disponible: 100 });
        const res = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${admin}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite }] });
        return { client, produit, commandeId: res.body.id };
    }

    const changerStatut = (id, statut, token = admin) =>
        request(app).put(`/api/commandes/${id}/statut`).set('Authorization', `Bearer ${token}`).send({ statut });

    describe('statuts de commande', () => {
        test('ANNULEE est terminal : ré-ouvrir puis ré-annuler ne libère pas le stock deux fois', async () => {
            const { client, produit, commandeId } = await creerCommande('B2B', 10);
            // On réserve une autre commande pour que « libérer deux fois » soit visible dans les compteurs.
            const autre = await request(app)
                .post('/api/commandes')
                .set('Authorization', `Bearer ${admin}`)
                .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 20 }] });
            expect(autre.status).toBe(201);

            expect((await changerStatut(commandeId, 'ANNULEE')).status).toBe(200);
            const reouverture = await changerStatut(commandeId, 'EN_ATTENTE');
            expect(reouverture.status).toBe(409);
            expect((await changerStatut(commandeId, 'ANNULEE')).status).toBe(409);

            const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
            expect(Number(stock.rows[0].quantite_disponible)).toBe(80); // 100 - 20 (seule la 2e commande reste réservée)
            expect(Number(stock.rows[0].quantite_reservee_b2b)).toBe(20);
            const c = await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id]);
            expect(Number(c.rows[0].solde_encours)).toBe(20000);
        });

        test('refuse le même statut et les retours en arrière, accepte les sauts en avant', async () => {
            const { commandeId } = await creerCommande('B2C', 2);
            expect((await changerStatut(commandeId, 'EN_ATTENTE')).status).toBe(409);
            expect((await changerStatut(commandeId, 'EN_LIVRAISON')).status).toBe(200);
            expect((await changerStatut(commandeId, 'PREPAREE')).status).toBe(409);
            expect((await changerStatut(commandeId, 'LIVREE')).status).toBe(200);
            expect((await changerStatut(commandeId, 'EN_ATTENTE')).status).toBe(409);
        });

        test('un livreur ne peut mettre que EN_LIVRAISON ou LIVREE', async () => {
            const { commandeId } = await creerCommande('B2C', 2);
            const livreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId });
            expect((await changerStatut(commandeId, 'ANNULEE', livreur)).status).toBe(403);
            expect((await changerStatut(commandeId, 'PREPAREE', livreur)).status).toBe(403);
            expect((await changerStatut(commandeId, 'EN_LIVRAISON', livreur)).status).toBe(200);
        });
    });

    describe('quantités', () => {
        test.each([-5, 0, 'abc', 1.5, 1000001, null])('une ligne de quantité %p est refusée et le stock ne bouge pas', async (quantite) => {
            const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
            const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, quantite_disponible: 100 });
            const res = await request(app)
                .post('/api/commandes')
                .set('Authorization', `Bearer ${admin}`)
                .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite }] });
            expect(res.status).toBe(400);
            const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
            expect(Number(stock.rows[0].quantite_disponible)).toBe(100);
            expect(Number(stock.rows[0].quantite_reservee_b2c)).toBe(0);
        });

        test("un abonnement avec une quantité négative, nulle ou absurde est refusé ; sans quantité, 1 par défaut", async () => {
            const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
            const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId });
            const envoyer = (quantite) =>
                request(app)
                    .post('/api/abonnements')
                    .set('Authorization', `Bearer ${admin}`)
                    .send({ client_id: client.id, produit_id: produit.id, jour_livraison: 'LUNDI', quantite });
            for (const q of [-3, 0, 'x', 5000000]) expect((await envoyer(q)).status).toBe(400);
            const ok = await envoyer(undefined);
            expect(ok.status).toBe(201);
            expect(Number(ok.body.quantite)).toBe(1);
        });
    });

    describe('fin de livraison', () => {
        async function livraisonPrete(montant = 10000) {
            const livreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId });
            const livreurId = require('jsonwebtoken').decode(livreur).id;
            const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
            const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId });
            const commande = (await pool.query(
                `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-SEC', $2, 'EN_LIVRAISON', $3) RETURNING *`,
                [tenantId, client.id, montant]
            )).rows[0];
            await pool.query(
                `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, 1, $3, $3)`,
                [commande.id, produit.id, montant]
            );
            await pool.query(`INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', $3)`, [tenantId, commande.id, montant]);
            const livraison = (await pool.query(
                `INSERT INTO livraisons (tenant_id, commande_id, livreur_id, date_prevue, statut) VALUES ($1, $2, $3, CURRENT_DATE, 'EN_COURS') RETURNING *`,
                [tenantId, commande.id, livreurId]
            )).rows[0];
            return { livreur, commande, livraison };
        }
        const terminer = (livraison, livreur, corps) =>
            request(app).put(`/api/logistique/livraisons/${livraison.id}/statut`).set('Authorization', `Bearer ${livreur}`).send(corps);

        test('renvoyer TERMINEE deux fois ne crée qu\'un seul paiement', async () => {
            const { livreur, commande, livraison } = await livraisonPrete(10000);
            expect((await terminer(livraison, livreur, { statut: 'TERMINEE', montant_encaisse: 4000 })).status).toBe(200);
            const second = await terminer(livraison, livreur, { statut: 'TERMINEE', montant_encaisse: 4000 });
            expect(second.status).toBe(409);
            const paiements = await pool.query(`SELECT * FROM paiements WHERE commande_id = $1`, [commande.id]);
            expect(paiements.rows).toHaveLength(1);
            const facture = await pool.query(`SELECT montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
            expect(Number(facture.rows[0].montant_restant)).toBe(6000);
        });

        test.each([-100, 1.5, 'abc', 10001])('montant_encaisse %p est refusé sans rien enregistrer', async (montant) => {
            const { livreur, commande, livraison } = await livraisonPrete(10000);
            const res = await terminer(livraison, livreur, { statut: 'TERMINEE', montant_encaisse: montant });
            expect(res.status).toBe(400);
            expect((await pool.query(`SELECT * FROM paiements WHERE commande_id = $1`, [commande.id])).rows).toHaveLength(0);
            const l = await pool.query(`SELECT statut FROM livraisons WHERE id = $1`, [livraison.id]);
            expect(l.rows[0].statut).toBe('EN_COURS');
        });

        test('un statut hors liste est refusé', async () => {
            const { livreur, livraison } = await livraisonPrete();
            expect((await terminer(livraison, livreur, { statut: 'PIRATE' })).status).toBe(400);
        });
    });

    describe('clients : hash du PIN', () => {
        test('aucune réponse ne contient pin_hash ni les colonnes de verrouillage', async () => {
            const creation = await request(app)
                .post('/api/clients')
                .set('Authorization', `Bearer ${admin}`)
                .send({ nom: 'Client PIN', type_client: 'B2C', telephone: '+221770001122', gps_lat: 14.7, gps_lng: -17.4 });
            expect(creation.status).toBe(201);
            const id = creation.body.id;
            const pin = await request(app).post(`/api/clients/${id}/pin`).set('Authorization', `Bearer ${admin}`);
            expect(pin.status).toBe(200);
            expect(pin.body.pin).toMatch(/^\d{6}$/);

            const liste = await request(app).get('/api/clients').set('Authorization', `Bearer ${admin}`);
            const maj = await request(app).put(`/api/clients/${id}`).set('Authorization', `Bearer ${admin}`).send({ nom: 'Nouveau nom' });
            expect(maj.status).toBe(200);
            for (const corps of [creation.body, liste.body[0], maj.body]) {
                expect(corps).not.toHaveProperty('pin_hash');
                expect(corps).not.toHaveProperty('pin_version');
                expect(corps).not.toHaveProperty('pin_tentatives_echouees');
                expect(corps).not.toHaveProperty('pin_bloque_jusqu');
                expect(corps).toHaveProperty('nom');
                expect(corps).toHaveProperty('solde_encours');
            }
        });
    });
});

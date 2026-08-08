const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

const JOURS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
const AUJOURDHUI = JOURS[new Date().getUTCDay()];

describe('abonnements — génération des commandes récurrentes', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['abonnements']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerAbonnement({ quantite = 2, jour = AUJOURDHUI } = {}) {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C', est_abonne: true });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2c: 1500, quantite_disponible: 100 });
        await pool.query(
            `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, frequence, jour_livraison, actif) VALUES ($1, $2, $3, $4, 'HEBDOMADAIRE', $5, TRUE)`,
            [tenantId, client.id, produit.id, quantite, jour]
        );
        return { client, produit };
    }

    test("crée une commande pour un abonnement dont le jour de livraison est aujourd'hui", async () => {
        const { client, produit } = await creerAbonnement({ quantite: 3 });

        const res = await request(app)
            .post('/api/abonnements/generer-commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send();

        expect(res.status).toBe(200);
        expect(res.body.creees).toBe(1);
        expect(res.body.echecs).toHaveLength(0);

        const commandes = await pool.query(`SELECT * FROM commandes WHERE client_id = $1`, [client.id]);
        expect(commandes.rows).toHaveLength(1);
        expect(Number(commandes.rows[0].montant_total)).toBe(4500);

        const stock = await pool.query(`SELECT quantite_disponible, quantite_reservee_b2c FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_disponible)).toBe(97);
        expect(Number(stock.rows[0].quantite_reservee_b2c)).toBe(3);
    });

    test('un second déclenchement le même jour ne crée pas de commande en double', async () => {
        const { client } = await creerAbonnement({ quantite: 2 });
        const token = await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId });

        const premier = await request(app).post('/api/abonnements/generer-commandes').set('Authorization', `Bearer ${token}`).send();
        expect(premier.body.creees).toBe(1);

        const second = await request(app).post('/api/abonnements/generer-commandes').set('Authorization', `Bearer ${token}`).send();
        expect(second.body.creees).toBe(0);

        const commandes = await pool.query(`SELECT * FROM commandes WHERE client_id = $1`, [client.id]);
        expect(commandes.rows).toHaveLength(1);
    });

    test("n'affecte pas les abonnements d'un autre jour de livraison", async () => {
        const autreJour = JOURS.find((j) => j !== AUJOURDHUI);
        const { client } = await creerAbonnement({ jour: autreJour });

        const res = await request(app)
            .post('/api/abonnements/generer-commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send();

        expect(res.body.creees).toBe(0);
        const commandes = await pool.query(`SELECT * FROM commandes WHERE client_id = $1`, [client.id]);
        expect(commandes.rows).toHaveLength(0);
    });

    test('stock insuffisant : échec propre et aucune commande orpheline', async () => {
        const { client } = await creerAbonnement({ quantite: 500 });

        const res = await request(app)
            .post('/api/abonnements/generer-commandes')
            .set('Authorization', `Bearer ${await creerUtilisateurEtToken(pool,{ role: 'admin', tenant_id: tenantId })}`)
            .send();

        expect(res.body.creees).toBe(0);
        expect(res.body.echecs.length).toBeGreaterThan(0);

        const commandes = await pool.query(`SELECT * FROM commandes WHERE client_id = $1`, [client.id]);
        expect(commandes.rows).toHaveLength(0);
    });
});

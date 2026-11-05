const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('dashboard — statistiques', () => {
    let pool;
    let app;
    let token;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['dashboard']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    // Régression : la courbe de CA à 14 jours groupait les commandes par jour avec un SQL
    // date_trunc(), non supporté par pg-mem (utilisé en dev local et par ce test) — la route
    // plantait avant même d'atteindre les autres statistiques.
    test('renvoie les statistiques sans planter, avec la courbe de CA groupée par jour', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, $3, 'LIVREE', $4, $5)`,
            [tenantId, 'CMD-1', client.id, 5000, new Date().toISOString()]
        );

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(Number(res.body.chiffreAffairesJour)).toBe(5000);
        expect(res.body.chiffreAffairesParJour).toHaveLength(14);
        const aujourdhui = new Date().toISOString().slice(0, 10);
        const pointDuJour = res.body.chiffreAffairesParJour.find((p) => p.date === aujourdhui);
        expect(Number(pointDuJour.value)).toBe(5000);
    });

    test('regroupe plusieurs commandes du même jour dans un seul point de la courbe', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const aujourdhuiISO = new Date().toISOString();
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, $3, 'LIVREE', $4, $5)`,
            [tenantId, 'CMD-A', client.id, 2000, aujourdhuiISO]
        );
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, $3, 'LIVREE', $4, $5)`,
            [tenantId, 'CMD-B', client.id, 3000, aujourdhuiISO]
        );

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const aujourdhui = new Date().toISOString().slice(0, 10);
        const pointDuJour = res.body.chiffreAffairesParJour.find((p) => p.date === aujourdhui);
        expect(Number(pointDuJour.value)).toBe(5000);
    });

    // Régression (05/11/2026) : la « Ferme démo » d'un essai insère deux ventes et un produit à stock 0 marqués est_demo ;
    // sans ce filtre, un nouveau gérant voyait une courbe de millions de FCFA et une alerte de stock qu'il n'avait jamais saisies.
    test('les ventes et le produit de la ferme démo ne comptent ni dans la courbe, ni dans le CA, ni dans les alertes de stock', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const maintenant = new Date().toISOString();
        const troisJours = new Date(Date.now() - 3 * 86400000).toISOString();
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le) VALUES ($1, 'CMD-DEMO-1', $2, 'LIVREE', 3300000, TRUE, $3)`,
            [tenantId, client.id, troisJours]
        );
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le) VALUES ($1, 'CMD-DEMO-2', $2, 'LIVREE', 777000, TRUE, $3)`,
            [tenantId, client.id, maintenant]
        );
        await creerProduitAvecStock(pool, { tenant_id: tenantId, nom: 'Poulet de chair (démo)', quantite_disponible: 0 });
        await pool.query(`UPDATE produits SET est_demo = TRUE WHERE tenant_id = $1`, [tenantId]);

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(Number(res.body.chiffreAffairesJour)).toBe(0);
        expect(res.body.chiffreAffairesParJour.every((p) => Number(p.value) === 0)).toBe(true);
        expect(res.body.produitsSousSeuil).toBe(0);
    });

    test('une vraie vente reste comptée quand la ferme a aussi des ventes de démo', async () => {
        const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
        const maintenant = new Date().toISOString();
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, est_demo, cree_le) VALUES ($1, 'CMD-DEMO-1', $2, 'LIVREE', 3300000, TRUE, $3)`,
            [tenantId, client.id, maintenant]
        );
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, 'CMD-REELLE', $2, 'LIVREE', 12000, $3)`,
            [tenantId, client.id, maintenant]
        );

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);

        expect(Number(res.body.chiffreAffairesJour)).toBe(12000);
    });

    test("une commande d'une autre organisation n'apparaît jamais dans les statistiques (isolation)", async () => {
        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const autreClient = await creerClient(pool, { tenant_id: autreTenantId, type_client: 'B2C' });
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, $3, 'LIVREE', $4, $5)`,
            [autreTenantId, 'CMD-AUTRE', autreClient.id, 999999, new Date().toISOString()]
        );

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(Number(res.body.chiffreAffairesJour)).toBe(0);
    });
});

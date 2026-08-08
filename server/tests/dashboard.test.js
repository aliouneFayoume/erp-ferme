const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

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

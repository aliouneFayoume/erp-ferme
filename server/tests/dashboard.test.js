const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('dashboard — statistiques', () => {
    let pool;
    let app;
    let token;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['dashboard']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable' });
    });

    afterEach(async () => {
        await pool.end();
    });

    // Régression : la courbe de CA à 14 jours groupait les commandes par jour avec un SQL
    // date_trunc(), non supporté par pg-mem (utilisé en dev local et par ce test) — la route
    // plantait avant même d'atteindre les autres statistiques.
    test('renvoie les statistiques sans planter, avec la courbe de CA groupée par jour', async () => {
        const client = await creerClient(pool, { type_client: 'B2C' });
        await pool.query(
            `INSERT INTO commandes (numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, 'LIVREE', $3, $4)`,
            ['CMD-1', client.id, 5000, new Date().toISOString()]
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
        const client = await creerClient(pool, { type_client: 'B2C' });
        const aujourdhuiISO = new Date().toISOString();
        await pool.query(
            `INSERT INTO commandes (numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, 'LIVREE', $3, $4)`,
            ['CMD-A', client.id, 2000, aujourdhuiISO]
        );
        await pool.query(
            `INSERT INTO commandes (numero_commande, client_id, statut, montant_total, cree_le) VALUES ($1, $2, 'LIVREE', $3, $4)`,
            ['CMD-B', client.id, 3000, aujourdhuiISO]
        );

        const res = await request(app).get('/api/dashboard/stats').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const aujourdhui = new Date().toISOString().slice(0, 10);
        const pointDuJour = res.body.chiffreAffairesParJour.find((p) => p.date === aujourdhui);
        expect(Number(pointDuJour.value)).toBe(5000);
    });
});

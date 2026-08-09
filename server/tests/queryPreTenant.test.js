const { queryPreTenant } = require('../src/auth');
const { createTestPool, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

/**
 * Régression pour l'incident du 2026-08-09 : une lecture pré-tenant (login, IPN, sous-domaine) ne
 * doit JAMAIS dépendre de l'hypothèse "une connexion du pool a un contexte vide par défaut" — cette
 * hypothèse s'est révélée fausse en production. queryPreTenant() doit systématiquement fonctionner
 * correctement même si un contexte tenant résiduel traîne déjà sur la connexion qu'il obtient
 * (ce que le stub pg-mem, qui partage son état entre "connexions", permet de simuler directement —
 * voir le commentaire dans db.js).
 */
describe('queryPreTenant — robustesse face à un contexte tenant résiduel', () => {
    let pool;
    let tenantA;
    let tenantB;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantA = await creerOrganisation(pool, 'Ferme A');
        tenantB = await creerOrganisation(pool, 'Ferme B');
        await pool.query(`UPDATE organisations SET slug = 'ferme-a' WHERE id = $1`, [tenantA]);
        await pool.query(`UPDATE organisations SET slug = 'ferme-b' WHERE id = $1`, [tenantB]);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('trouve une organisation même si un current_tenant_id résiduel pointe vers une AUTRE organisation', async () => {
        // Simule le contexte "poisoned" observé en production : un current_tenant_id qui traîne,
        // posé par une requête précédente sans rapport, jamais remis à zéro.
        await pool.query("SELECT set_config('app.current_tenant_id', $1, false)", [String(tenantA)]);

        const result = await queryPreTenant(pool, `SELECT nom FROM organisations WHERE slug = $1`, ['ferme-b']);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].nom).toBe('Ferme B');
    });

    test('remet le contexte à vide après la requête (ne contamine pas la connexion suivante)', async () => {
        await pool.query("SELECT set_config('app.current_tenant_id', $1, false)", [String(tenantA)]);
        await queryPreTenant(pool, `SELECT 1`, []);

        const etat = await pool.query(`SELECT current_setting('app.current_tenant_id', true) as val`);
        expect(etat.rows[0].val === null || etat.rows[0].val === '').toBe(true);
    });

    test("login staff fonctionne même avec un current_tenant_id résiduel pointant vers une autre organisation", async () => {
        const bcrypt = require('bcryptjs');
        const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`);
        const hash = await bcrypt.hash('motdepasse123', 4);
        await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif) VALUES ($1, 'Admin B', 'admin-b@test.sn', $2, $3, TRUE)`,
            [tenantB, hash, roleRes.rows[0].id]
        );
        // Contexte résiduel pointant vers la MAUVAISE organisation (A, pas B où est le compte).
        await pool.query("SELECT set_config('app.current_tenant_id', $1, false)", [String(tenantA)]);

        const request = require('supertest');
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/api/auth', require('../src/routes/auth')(pool));

        const res = await request(app).post('/api/auth/login').send({ email: 'admin-b@test.sn', password: 'motdepasse123' });

        expect(res.status).toBe(200);
        expect(res.body.utilisateur.tenant_id).toBe(tenantB);
    });
});

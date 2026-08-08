const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

const CODE = process.env.SIGNUP_INVITE_CODE || 'demo-inscription-ferme-massla';

function payloadValide(overrides = {}) {
    return {
        code: CODE,
        nomFerme: 'Ferme Test',
        secteurs: [{ nom: 'Avicole', suiviRecolte: false }, { nom: 'Maraîcher', suiviRecolte: true }],
        adminNomComplet: 'Admin Test',
        adminEmail: `admin-${Date.now()}@test.sn`,
        adminPassword: 'motdepasse123',
        ...overrides,
    };
}

describe('inscription — création self-service d\'une nouvelle ferme', () => {
    let pool;
    let app;

    beforeEach(async () => {
        // Le limiteur de débit (express-rate-limit) est instancié une fois au chargement du module
        // route — sans ce reset, son état s'accumulerait sur tout le fichier de test au lieu d'être
        // isolé par test comme le reste (chaque test a son propre pool pg-mem). Jest a son propre
        // registre de modules, indépendant de require.cache — jest.resetModules() est la bonne API.
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['inscription']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée l\'organisation, ses secteurs et le premier admin, et renvoie un token de connexion immédiate', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide());

        expect(res.status).toBe(201);
        expect(res.body.token).toBeTruthy();
        expect(res.body.utilisateur.role).toBe('admin');

        const org = await pool.query(`SELECT * FROM organisations WHERE nom = 'Ferme Test'`);
        expect(org.rows).toHaveLength(1);
        const tenantId = org.rows[0].id;

        const secteurs = await pool.query(`SELECT nom, suivi_recolte FROM secteurs WHERE tenant_id = $1 ORDER BY nom`, [tenantId]);
        expect(secteurs.rows.map((s) => s.nom)).toEqual(['Avicole', 'Maraîcher']);
        expect(secteurs.rows.find((s) => s.nom === 'Maraîcher').suivi_recolte).toBe(true);
        expect(secteurs.rows.find((s) => s.nom === 'Avicole').suivi_recolte).toBe(false);

        const admin = await pool.query(
            `SELECT u.email, r.nom as role FROM utilisateurs u JOIN roles r ON u.role_id = r.id WHERE u.tenant_id = $1`,
            [tenantId]
        );
        expect(admin.rows).toHaveLength(1);
        expect(admin.rows[0].role).toBe('admin');
    });

    test('rejette un code d\'invitation invalide sans rien créer', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide({ code: 'mauvais-code' }));

        expect(res.status).toBe(403);
        const org = await pool.query(`SELECT * FROM organisations WHERE nom = 'Ferme Test'`);
        expect(org.rows).toHaveLength(0);
    });

    test('rejette une inscription sans aucun secteur', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide({ secteurs: [] }));
        expect(res.status).toBe(400);
    });

    test('rejette un mot de passe trop court', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide({ adminPassword: 'abc' }));
        expect(res.status).toBe(400);
    });

    test('rejette une deuxième inscription avec le même email admin, avec un message clair', async () => {
        const email = `doublon-${Date.now()}@test.sn`;
        const premiere = await request(app).post('/api/inscription').send(payloadValide({ adminEmail: email, nomFerme: 'Ferme Une' }));
        expect(premiere.status).toBe(201);

        const deuxieme = await request(app).post('/api/inscription').send(payloadValide({ adminEmail: email, nomFerme: 'Ferme Deux' }));
        expect(deuxieme.status).toBe(409);
        // Note : on ne vérifie pas ici l'absence d'organisation orpheline malgré le ROLLBACK — pg-mem
        // ne simule pas réellement l'annulation transactionnelle (BEGIN/COMMIT/ROLLBACK sont acceptés
        // syntaxiquement mais un ROLLBACK ne défait pas les écritures déjà faites), contrairement à un
        // vrai PostgreSQL. Le comportement transactionnel réel n'est donc vérifiable que manuellement,
        // pas via cette suite — même limite déjà documentée pour RLS (voir verify-rls.js).
    });

    test('deux fermes créées séparément sont bien isolées (secteurs et admin distincts)', async () => {
        const resA = await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Ferme Alpha', adminEmail: `alpha-${Date.now()}@test.sn` }));
        const resB = await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Ferme Beta', adminEmail: `beta-${Date.now()}@test.sn` }));

        expect(resA.body.utilisateur.tenant_id).not.toBe(resB.body.utilisateur.tenant_id);

        const secteursA = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [resA.body.utilisateur.tenant_id]);
        const secteursB = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [resB.body.utilisateur.tenant_id]);
        expect(secteursA.rows).toHaveLength(2);
        expect(secteursB.rows).toHaveLength(2);
    });
});

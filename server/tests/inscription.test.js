const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

// Durcissement sécurité (migration-20) : creerFerme.js refuse de créer un compte si l'envoi de
// l'email de vérification n'est pas configuré (503) — jamais de vrai appel réseau vers Resend en
// test (voir mfa/whatsapp, même principe : ne jamais toucher une vraie API tierce depuis la suite).
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));

const CODE = process.env.SIGNUP_INVITE_CODE || 'demo-inscription-ferme-massla';

function payloadValide(overrides = {}) {
    return {
        code: CODE,
        nomFerme: 'Ferme Test',
        secteurs: [{ nom: 'Avicole', suiviRecolte: false }, { nom: 'Maraîcher', suiviRecolte: true }],
        adminNomComplet: 'Admin Test',
        adminEmail: `admin-${Date.now()}@test.sn`,
        adminPassword: 'Motdepasse123!',
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

    test('crée l\'organisation, ses secteurs et le premier admin, sans connexion automatique', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide());

        expect(res.status).toBe(201);
        // Durcissement sécurité (migration-20) : plus de token/utilisateur dans la réponse — l'admin
        // créé est email_verifie=FALSE et doit vérifier son adresse avant de pouvoir se connecter
        // (voir la correction de conception dans le plan : l'auto-login contournait la vérification).
        expect(res.body.token).toBeUndefined();
        expect(res.body.utilisateur).toBeUndefined();
        expect(res.body.message).toBeTruthy();

        const org = await pool.query(`SELECT * FROM organisations WHERE nom = 'Ferme Test'`);
        expect(org.rows).toHaveLength(1);
        const tenantId = org.rows[0].id;

        const secteurs = await pool.query(`SELECT nom, suivi_recolte FROM secteurs WHERE tenant_id = $1 ORDER BY nom`, [tenantId]);
        expect(secteurs.rows.map((s) => s.nom)).toEqual(['Avicole', 'Maraîcher']);
        expect(secteurs.rows.find((s) => s.nom === 'Maraîcher').suivi_recolte).toBe(true);
        expect(secteurs.rows.find((s) => s.nom === 'Avicole').suivi_recolte).toBe(false);

        const admin = await pool.query(
            `SELECT u.email, r.nom as role, u.email_verifie, u.mfa_obligatoire FROM utilisateurs u JOIN roles r ON u.role_id = r.id WHERE u.tenant_id = $1`,
            [tenantId]
        );
        expect(admin.rows).toHaveLength(1);
        expect(admin.rows[0].role).toBe('admin');
        expect(admin.rows[0].email_verifie).toBe(false);
        expect(admin.rows[0].mfa_obligatoire).toBe(true);
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

    // Audit sécurité 2026-08-11 (M2) : un nom de secteur contenant du HTML/JS s'exécutait sans
    // échappement dans Catalogue et Comptabilité (corrigé le même jour) — cette validation retire
    // la possibilité même d'y injecter des caractères dangereux, en défense en profondeur.
    test('rejette un nom de secteur contenant des caractères HTML/script (XSS)', async () => {
        const res = await request(app).post('/api/inscription').send(
            payloadValide({ secteurs: [{ nom: '<img src=x onerror=alert(1)>', suiviRecolte: false }] })
        );
        expect(res.status).toBe(400);
        const org = await pool.query(`SELECT * FROM organisations WHERE nom = 'Ferme Test'`);
        expect(org.rows).toHaveLength(0);
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

    // Durcissement sécurité (migration-20) : la réponse ne porte plus tenant_id (plus de token de
    // connexion immédiate) — l'organisation créée est retrouvée par son nom, unique dans ces tests.
    async function tenantIdParNom(nom) {
        const res = await pool.query(`SELECT id FROM organisations WHERE nom = $1`, [nom]);
        return res.rows[0].id;
    }

    test('génère un slug (sous-domaine) dérivé du nom de la ferme', async () => {
        const res = await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Ferme Écologique du Sénégal', adminEmail: `slug-${Date.now()}@test.sn` }));
        expect(res.status).toBe(201);
        const tenantId = await tenantIdParNom('Ferme Écologique du Sénégal');
        const org = await pool.query(`SELECT slug FROM organisations WHERE id = $1`, [tenantId]);
        expect(org.rows[0].slug).toBe('ferme-ecologique-du-senegal');
    });

    test('deux fermes de même nom reçoivent des slugs distincts (suffixe -2)', async () => {
        await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Même Nom', adminEmail: `meme-a-${Date.now()}@test.sn` }));
        await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Même Nom', adminEmail: `meme-b-${Date.now()}@test.sn` }));

        const orgs = await pool.query(`SELECT slug FROM organisations WHERE nom = 'Même Nom' ORDER BY id`);
        expect(orgs.rows.map((o) => o.slug)).toEqual(['meme-nom', 'meme-nom-2']);
    });

    test('deux fermes créées séparément sont bien isolées (secteurs et admin distincts)', async () => {
        await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Ferme Alpha', adminEmail: `alpha-${Date.now()}@test.sn` }));
        await request(app).post('/api/inscription').send(payloadValide({ nomFerme: 'Ferme Beta', adminEmail: `beta-${Date.now()}@test.sn` }));

        const tenantIdA = await tenantIdParNom('Ferme Alpha');
        const tenantIdB = await tenantIdParNom('Ferme Beta');
        expect(tenantIdA).not.toBe(tenantIdB);

        const secteursA = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [tenantIdA]);
        const secteursB = await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [tenantIdB]);
        expect(secteursA.rows).toHaveLength(2);
        expect(secteursB.rows).toHaveLength(2);
    });
});

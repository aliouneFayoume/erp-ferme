const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Audit sécurité 2026-08-11 (E2) : chaque route sensible de routes/utilisateurs.js doit incrémenter
// token_version, pour que requireAuth (auth.js) rejette immédiatement toute session déjà ouverte
// pour le compte concerné — sans attendre les 12h d'expiration naturelle du JWT.
describe('utilisateurs : révocation de session (token_version)', () => {
    let pool, app, tenantId, tokenAdmin;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Révocation');
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['utilisateurs']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerCible(overrides = {}) {
        const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = 'comptable'`);
        const res = await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif)
             VALUES ($1, 'Cible Test', $2, 'x', $3, TRUE) RETURNING id, token_version`,
            [tenantId, overrides.email || `cible-${Date.now()}@test.sn`, roleRes.rows[0].id]
        );
        return res.rows[0];
    }

    test('changer le mot de passe incrémente token_version', async () => {
        const cible = await creerCible();
        await request(app)
            .put(`/api/utilisateurs/${cible.id}/mot-de-passe`)
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ password: 'Nouveau-mdp-2026!' });

        const apres = await pool.query(`SELECT token_version FROM utilisateurs WHERE id = $1`, [cible.id]);
        expect(apres.rows[0].token_version).toBe(cible.token_version + 1);
    });

    test('modifier le rôle incrémente token_version', async () => {
        const cible = await creerCible();
        await request(app)
            .put(`/api/utilisateurs/${cible.id}`)
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ role: 'livreur' });

        const apres = await pool.query(`SELECT token_version FROM utilisateurs WHERE id = $1`, [cible.id]);
        expect(apres.rows[0].token_version).toBe(cible.token_version + 1);
    });

    test('supprimer un compte incrémente token_version', async () => {
        const cible = await creerCible();
        await request(app).delete(`/api/utilisateurs/${cible.id}`).set('Authorization', `Bearer ${tokenAdmin}`);

        const apres = await pool.query(`SELECT token_version, actif, deleted_at FROM utilisateurs WHERE id = $1`, [cible.id]);
        expect(apres.rows[0].token_version).toBe(cible.token_version + 1);
        expect(apres.rows[0].actif).toBe(false);
        expect(apres.rows[0].deleted_at).not.toBeNull();
    });

    test('bout en bout : un token émis avant un changement de mot de passe est rejeté après', async () => {
        const cible = await creerCible({ email: 'e2e@test.sn' });
        const { signToken } = require('../src/auth');
        // Jeton "déjà en poche" au moment où l'admin change le mot de passe de cette cible — même
        // scénario qu'un employé licencié dont le jeton reste, avant ce correctif, valide 12h.
        const jetonAvant = signToken(
            { id: cible.id, role_nom: 'comptable', nom_complet: 'Cible Test', tenant_id: tenantId, token_version: cible.token_version },
            {}
        );

        // GET / est accessible à 'comptable' (checkRole(['admin', 'comptable'])) : un 200 confirmerait
        // une session encore valide, distinct d'un 403 de rôle qui ne prouverait rien ici.
        const avant = await request(app).get('/api/utilisateurs/').set('Authorization', `Bearer ${jetonAvant}`);
        expect(avant.status).toBe(200);

        await request(app)
            .put(`/api/utilisateurs/${cible.id}/mot-de-passe`)
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ password: 'Un-autre-mdp-2026!' });

        const apres = await request(app).get('/api/utilisateurs/').set('Authorization', `Bearer ${jetonAvant}`);
        expect(apres.status).toBe(401);
    });
});

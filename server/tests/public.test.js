const request = require('supertest');
const publicRoutes = require('../src/routes/public');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');

describe('public — extraction du slug depuis le hostname', () => {
    const { extraireSlug } = publicRoutes;

    test('domaine racine et www ne sont jamais un sous-domaine de ferme', () => {
        expect(extraireSlug('massla.sn')).toBeNull();
        expect(extraireSlug('www.massla.sn')).toBeNull();
    });

    test('un sous-domaine simple est extrait', () => {
        expect(extraireSlug('ferme-test.massla.sn')).toBe('ferme-test');
    });

    test('un domaine sans rapport ne renvoie rien', () => {
        expect(extraireSlug('autredomaine.sn')).toBeNull();
        expect(extraireSlug('massla.sn.autredomaine.com')).toBeNull();
    });

    test('un sous-domaine à plusieurs niveaux est rejeté (non supporté)', () => {
        expect(extraireSlug('a.b.massla.sn')).toBeNull();
    });

    test('hostname vide ou absent ne casse rien', () => {
        expect(extraireSlug('')).toBeNull();
        expect(extraireSlug(undefined)).toBeNull();
    });
});

describe('public — GET /organisation (résolution de marque avant connexion)', () => {
    let pool;
    let app;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['public']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('renvoie le nom de la ferme quand le sous-domaine correspond à un slug existant', async () => {
        await pool.query(`INSERT INTO organisations (nom, slug) VALUES ('Ferme Test', 'ferme-test')`);

        const res = await request(app).get('/api/public/organisation').set('Host', 'ferme-test.massla.sn');

        expect(res.status).toBe(200);
        expect(res.body.nom).toBe('Ferme Test');
    });

    test('renvoie nom: null pour le domaine racine', async () => {
        await pool.query(`INSERT INTO organisations (nom, slug) VALUES ('Ferme Test', 'ferme-test')`);

        const res = await request(app).get('/api/public/organisation').set('Host', 'massla.sn');

        expect(res.status).toBe(200);
        expect(res.body.nom).toBeNull();
    });

    test('renvoie nom: null pour un slug inconnu', async () => {
        const res = await request(app).get('/api/public/organisation').set('Host', 'inconnue.massla.sn');

        expect(res.status).toBe(200);
        expect(res.body.nom).toBeNull();
    });

    test('une ferme supprimée (soft delete) ne résout plus son sous-domaine', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Supprimée');
        await pool.query(`UPDATE organisations SET slug = 'ferme-supprimee', deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [tenantId]);

        const res = await request(app).get('/api/public/organisation').set('Host', 'ferme-supprimee.massla.sn');

        expect(res.status).toBe(200);
        expect(res.body.nom).toBeNull();
    });
});

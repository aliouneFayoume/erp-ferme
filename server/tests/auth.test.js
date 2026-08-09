const request = require('supertest');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createTestPool, seedRolesEtSecteurs, creerOrganisation, tokenPour } = require('./helpers/testApp');
const { requireAuth, checkRole, signToken } = require('../src/auth');

async function creerUtilisateur(pool, { email = 'test@massla.sn', motDePasse = 'demo1234', role = 'admin', actif = true, tenant_id = null } = {}) {
    const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = $1`, [role]);
    const hash = await bcrypt.hash(motDePasse, 4);
    await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant_id, 'Utilisateur Test', email, hash, roleRes.rows[0].id, actif]
    );
}

describe('auth — login', () => {
    let pool;
    let app;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = express();
        app.use(express.json());
        app.use('/api/auth', require('../src/routes/auth')(pool));
    });

    afterEach(async () => {
        await pool.end();
    });

    test('connexion réussie avec des identifiants valides renvoie un token et le rôle', async () => {
        await creerUtilisateur(pool, { email: 'admin@test.sn', motDePasse: 'demo1234', role: 'admin' });

        const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.sn', password: 'demo1234' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.utilisateur.role).toBe('admin');
    });

    test('mot de passe incorrect est rejeté', async () => {
        await creerUtilisateur(pool, { email: 'admin@test.sn', motDePasse: 'demo1234', role: 'admin' });

        const res = await request(app).post('/api/auth/login').send({ email: 'admin@test.sn', password: 'mauvais-mdp' });

        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
    });

    test('un utilisateur désactivé ne peut pas se connecter', async () => {
        await creerUtilisateur(pool, { email: 'inactif@test.sn', motDePasse: 'demo1234', role: 'admin', actif: false });

        const res = await request(app).post('/api/auth/login').send({ email: 'inactif@test.sn', password: 'demo1234' });

        expect(res.status).toBe(401);
    });

    test("une organisation dont l'abonnement SaaS est suspendu ne peut pas se connecter", async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Suspendue');
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel, actif) VALUES ($1, 40000, FALSE)`,
            [tenantId]
        );
        await creerUtilisateur(pool, { email: 'suspendu@test.sn', motDePasse: 'demo1234', role: 'admin', tenant_id: tenantId });

        const res = await request(app).post('/api/auth/login').send({ email: 'suspendu@test.sn', password: 'demo1234' });

        expect(res.status).toBe(403);
    });

    test('une organisation supprimée ne peut pas se connecter', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Supprimée');
        await pool.query(`UPDATE organisations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [tenantId]);
        await creerUtilisateur(pool, { email: 'supprime@test.sn', motDePasse: 'demo1234', role: 'admin', tenant_id: tenantId });

        const res = await request(app).post('/api/auth/login').send({ email: 'supprime@test.sn', password: 'demo1234' });

        expect(res.status).toBe(403);
    });

    test('une organisation sans ligne d\'abonnement (jamais mise sous facturation) peut se connecter normalement', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Sans Facturation');
        await creerUtilisateur(pool, { email: 'sans-facturation@test.sn', motDePasse: 'demo1234', role: 'admin', tenant_id: tenantId });

        const res = await request(app).post('/api/auth/login').send({ email: 'sans-facturation@test.sn', password: 'demo1234' });

        expect(res.status).toBe(200);
    });
});

describe('auth — middlewares requireAuth / checkRole', () => {
    let pool;
    let app;

    beforeEach(() => {
        pool = createTestPool();
        app = express();
        app.get('/protegee', requireAuth(pool), (req, res) => res.json({ ok: true }));
        app.get('/comptable-seulement', requireAuth(pool), checkRole(['comptable']), (req, res) => res.json({ ok: true }));
    });

    afterEach(async () => {
        await pool.end();
    });

    test('requête sans token est rejetée (401)', async () => {
        const res = await request(app).get('/protegee');
        expect(res.status).toBe(401);
    });

    test('token invalide est rejeté (401)', async () => {
        const res = await request(app).get('/protegee').set('Authorization', 'Bearer token-invalide');
        expect(res.status).toBe(401);
    });

    test('token valide donne accès à une route protégée', async () => {
        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${tokenPour({ role: 'livreur' })}`);
        expect(res.status).toBe(200);
    });

    test('checkRole refuse un rôle non autorisé', async () => {
        const res = await request(app).get('/comptable-seulement').set('Authorization', `Bearer ${tokenPour({ role: 'livreur' })}`);
        expect(res.status).toBe(403);
    });

    test('checkRole laisse toujours passer admin, même hors liste', async () => {
        const res = await request(app).get('/comptable-seulement').set('Authorization', `Bearer ${tokenPour({ role: 'admin' })}`);
        expect(res.status).toBe(200);
    });

    test('un token déjà émis est bloqué immédiatement si son organisation est suspendue entre-temps', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Suspendue En Cours de Session');
        const token = tokenPour({ role: 'admin', tenant_id: tenantId });

        const avant = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(avant.status).toBe(200);

        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel, actif) VALUES ($1, 40000, FALSE)`,
            [tenantId]
        );

        const apres = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(apres.status).toBe(403);
    });

    test('un token déjà émis est bloqué immédiatement si son organisation est supprimée entre-temps', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Supprimée En Cours de Session');
        const token = tokenPour({ role: 'admin', tenant_id: tenantId });

        await pool.query(`UPDATE organisations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [tenantId]);

        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    test("un token d'impersonation ignore le blocage, pour que le superviseur puisse dépanner une ferme suspendue", async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Suspendue Mais Dépannée');
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel, actif) VALUES ($1, 40000, FALSE)`,
            [tenantId]
        );
        const tokenImpersonation = signToken({ id: 1, role_nom: 'admin', nom_complet: 'Admin Ferme', tenant_id: tenantId }, { viaImpersonation: true });

        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${tokenImpersonation}`);
        expect(res.status).toBe(200);
    });
});

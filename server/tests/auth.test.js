const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const express = require('express');
const { createTestPool, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');
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

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
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

    // requireAuth vérifie désormais l'identité en base à chaque requête (audit sécurité 2026-08-11,
    // E2) : un token signé sans ligne utilisateurs correspondante est rejeté par construction — les
    // tests ci-dessous utilisent donc creerUtilisateurEtToken (vraie ligne + vrai token_version),
    // jamais le raccourci synthétique tokenPour.

    test('token valide donne accès à une route protégée', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'livreur' });
        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });

    test('checkRole refuse un rôle non autorisé', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'livreur' });
        const res = await request(app).get('/comptable-seulement').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    test('checkRole laisse toujours passer admin, même hors liste', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin' });
        const res = await request(app).get('/comptable-seulement').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });

    test('un token déjà émis est bloqué immédiatement si son organisation est suspendue entre-temps', async () => {
        const tenantId = await creerOrganisation(pool, 'Ferme Suspendue En Cours de Session');
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });

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
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });

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
        const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`);
        const adminRes = await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif)
             VALUES ($1, 'Admin Ferme', 'admin-depanne@test.sn', 'x', $2, TRUE) RETURNING id, token_version`,
            [tenantId, roleRes.rows[0].id]
        );
        const admin = adminRes.rows[0];
        const tokenImpersonation = signToken(
            { id: admin.id, role_nom: 'admin', nom_complet: 'Admin Ferme', tenant_id: tenantId, token_version: admin.token_version },
            { viaImpersonation: true }
        );

        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${tokenImpersonation}`);
        expect(res.status).toBe(200);
    });

    // Audit sécurité 2026-08-11 (E4) : une session d'impersonation était valable aussi longtemps
    // qu'une session staff normale (12h) alors qu'elle sert à un dépannage ponctuel.
    test("un token d'impersonation expire en 45 minutes, pas 12h comme une session normale", () => {
        const tokenNormal = signToken({ id: 1, role_nom: 'admin', nom_complet: 'Admin', tenant_id: 1, token_version: 1 }, {});
        const tokenImpersonation = signToken({ id: 1, role_nom: 'admin', nom_complet: 'Admin', tenant_id: 1, token_version: 1 }, { viaImpersonation: true });

        const dureeNormale = jwt.decode(tokenNormal).exp - jwt.decode(tokenNormal).iat;
        const dureeImpersonation = jwt.decode(tokenImpersonation).exp - jwt.decode(tokenImpersonation).iat;

        expect(dureeNormale).toBe(12 * 60 * 60);
        expect(dureeImpersonation).toBe(45 * 60);
    });

    test('un token est rejeté après un changement de mot de passe (token_version incrémenté)', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin' });
        const avant = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(avant.status).toBe(200);

        const decoded = jwt.decode(token);
        await pool.query(`UPDATE utilisateurs SET token_version = token_version + 1 WHERE id = $1`, [decoded.id]);

        const apres = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(apres.status).toBe(401);
    });

    test('un token est rejeté si le compte est désactivé entre-temps', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin' });
        const decoded = jwt.decode(token);
        await pool.query(`UPDATE utilisateurs SET actif = FALSE WHERE id = $1`, [decoded.id]);

        const res = await request(app).get('/protegee').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(401);
    });
});

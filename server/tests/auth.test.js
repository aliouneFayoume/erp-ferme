const request = require('supertest');
const bcrypt = require('bcryptjs');
const express = require('express');
const { createTestPool, seedRolesEtSecteurs, tokenPour } = require('./helpers/testApp');
const { requireAuth, checkRole } = require('../src/auth');

async function creerUtilisateur(pool, { email = 'test@massla.sn', motDePasse = 'demo1234', role = 'admin', actif = true } = {}) {
    const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = $1`, [role]);
    const hash = await bcrypt.hash(motDePasse, 4);
    await pool.query(
        `INSERT INTO utilisateurs (nom_complet, email, mot_de_passe_hash, role_id, actif) VALUES ($1, $2, $3, $4, $5)`,
        ['Utilisateur Test', email, hash, roleRes.rows[0].id, actif]
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
});

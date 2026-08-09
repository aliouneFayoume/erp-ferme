const fs = require('fs');
const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-erp-massla';

const { signToken } = require('../../src/auth');
const { registerGucStubs } = require('../../src/db');

/** Base pg-mem fraîche avec le schéma réel appliqué — une par test (isolation totale). */
function createTestPool() {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    registerGucStubs(db);
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'schema.sql'), 'utf-8');
    db.public.none(schema);
    const { Pool } = db.adapters.createPg();
    return new Pool();
}

/** Monte uniquement les routes nécessaires au test sur un pool donné. */
function buildApp(pool, routeNames) {
    const app = express();
    app.use(express.json());
    for (const name of routeNames) {
        app.use(`/api/${name}`, require(`../../src/routes/${name}`)(pool));
    }
    return app;
}

/** Jeu de données minimal partagé (rôles + secteurs), requis par les FK d'utilisateurs/produits. */
async function seedRolesEtSecteurs(pool) {
    const roles = ['admin', 'comptable', 'chef_prod', 'livreur'];
    for (const r of roles) {
        await pool.query(`INSERT INTO roles (nom) VALUES ($1)`, [r]);
    }
    const secteurs = ['Avicole', 'Piscicole', 'Maraîcher'];
    for (const s of secteurs) {
        await pool.query(`INSERT INTO secteurs (nom) VALUES ($1)`, [s]);
    }
}

/** Organisation de test (prototype multi-tenant) — requise dès qu'une route filtre par tenant_id. */
async function creerOrganisation(pool, nom = 'Organisation Test') {
    const res = await pool.query(`INSERT INTO organisations (nom) VALUES ($1) RETURNING id`, [nom]);
    return res.rows[0].id;
}

async function creerClient(pool, overrides = {}) {
    const c = {
        tenant_id: null,
        nom: 'Client Test',
        type_client: 'B2C',
        categorie_tarifaire: 'standard',
        telephone: `+22177${Math.floor(1000000 + Math.random() * 8999999)}`,
        limite_credit: 0,
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours)
         VALUES ($1, $2, $3, $4, $5, $6, 0) RETURNING *`,
        [c.tenant_id, c.nom, c.type_client, c.categorie_tarifaire, c.telephone, c.limite_credit]
    );
    return res.rows[0];
}

async function creerProduitAvecStock(pool, overrides = {}) {
    const p = {
        tenant_id: null,
        secteur_id: 1,
        nom: 'Produit Test',
        unite_mesure: 'KG',
        prix_unitaire_b2b: 1000,
        prix_unitaire_b2c: 1500,
        prix_unitaire_grossiste: null,
        quantite_disponible: 100,
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [p.tenant_id, p.secteur_id, p.nom, p.unite_mesure, p.prix_unitaire_b2b, p.prix_unitaire_b2c, p.prix_unitaire_grossiste]
    );
    const produit = res.rows[0];
    await pool.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, $2)`, [produit.id, p.quantite_disponible]);
    return produit;
}

/**
 * Fabrique un token JWT valide sans passer par bcrypt/login (tests ciblés sur la logique métier).
 * Ne crée PAS de ligne dans `utilisateurs` — à réserver aux tests qui n'exercent pas le journal
 * d'audit (celui-ci a une FK vers utilisateurs.id, voir creerUtilisateurEtToken ci-dessous).
 */
function tokenPour({ id = 1, role = 'admin', nom_complet = 'Testeur', secteur_id = null, tenant_id = null } = {}) {
    return signToken({ id, role_nom: role, nom_complet, secteur_id, tenant_id });
}

/**
 * Crée un vrai utilisateur en base (requiert que seedRolesEtSecteurs ait tourné) et renvoie un
 * token correspondant à son id réel — nécessaire dès qu'une route appelle logAudit avec ce userId,
 * sous peine de violer la FK audit_logs.utilisateur_id -> utilisateurs.id.
 */
async function creerUtilisateurEtToken(pool, { role = 'admin', nom_complet = 'Testeur', secteur_id = null, tenant_id = null, estSuperviseurPlateforme = false } = {}) {
    const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = $1`, [role]);
    const email = `${role}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.sn`;
    const res = await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, secteur_id, est_superviseur_plateforme) VALUES ($1, $2, $3, 'x', $4, $5, $6) RETURNING id`,
        [tenant_id, nom_complet, email, roleRes.rows[0].id, secteur_id, estSuperviseurPlateforme]
    );
    return signToken({ id: res.rows[0].id, role_nom: role, nom_complet, secteur_id, tenant_id, est_superviseur_plateforme: estSuperviseurPlateforme });
}

module.exports = {
    createTestPool,
    buildApp,
    seedRolesEtSecteurs,
    creerOrganisation,
    creerClient,
    creerProduitAvecStock,
    tokenPour,
    creerUtilisateurEtToken,
};

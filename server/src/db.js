const fs = require('fs');
const path = require('path');

/**
 * pg-mem ne connaît ni `current_setting` ni `set_config` nativement. On simule un stockage
 * clé/valeur en mémoire pour que le contexte tenant posé par `attachTenantConnection` (auth.js)
 * soit lisible — ce qui exerce le plumbing sous les tests, sans reproduire l'isolation par
 * connexion/session d'un vrai PostgreSQL (pg-mem partage cet état entre toutes les "connexions"
 * d'une même instance en mémoire). Ça ne remplace donc jamais la vérification RLS réelle
 * (verify-rls.js contre la vraie base) : ça garantit juste que rien ne casse côté application.
 */
function registerGucStubs(db) {
    const guc = new Map();
    db.public.registerFunction({
        name: 'current_setting',
        args: ['text', 'bool'],
        returns: 'text',
        implementation: (name) => guc.get(name) ?? null,
    });
    db.public.registerFunction({
        name: 'set_config',
        args: ['text', 'text', 'bool'],
        returns: 'text',
        implementation: (name, value) => {
            guc.set(name, value || null);
            return value;
        },
    });
}

/**
 * Fournit un Pool compatible `pg`. Si DATABASE_URL est défini, on se connecte
 * à une vraie instance PostgreSQL (ex: Supabase, VPS). Sinon, on démarre une
 * base PostgreSQL en mémoire (pg-mem) pour permettre une démo/simulation
 * sans installation locale — même schéma SQL, même driver `pg`, mêmes requêtes.
 */
function createPool() {
    if (process.env.DATABASE_URL) {
        const { Pool } = require('pg');
        // Audit systèmes 2026-08-11 (item #10) : sans ces bornes, une base injoignable ou une requête
        // bloquée gèle silencieusement toutes les requêtes en attente d'une connexion du pool — la
        // seule limite était le timeout HTTP du reverse proxy, en amont, jamais celui-ci.
        return {
            pool: new Pool({
                connectionString: process.env.DATABASE_URL,
                connectionTimeoutMillis: 5000, // temps max pour obtenir une connexion du pool
                idleTimeoutMillis: 30000, // ferme les connexions inactives plutôt que de les garder ouvertes indéfiniment
                statement_timeout: 15000, // tue côté Postgres toute requête qui dépasserait 15s
            }),
            mode: 'postgres',
        };
    }

    const { newDb } = require('pg-mem');
    const db = newDb({ autoCreateForeignKeyIndices: true });
    registerGucStubs(db);

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.public.none(schema);

    const { Pool } = db.adapters.createPg();
    return { pool: new Pool(), mode: 'pg-mem (simulation en mémoire)' };
}

module.exports = { createPool, registerGucStubs };

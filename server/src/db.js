const fs = require('fs');
const path = require('path');

/**
 * Fournit un Pool compatible `pg`. Si DATABASE_URL est défini, on se connecte
 * à une vraie instance PostgreSQL (ex: Supabase, VPS). Sinon, on démarre une
 * base PostgreSQL en mémoire (pg-mem) pour permettre une démo/simulation
 * sans installation locale — même schéma SQL, même driver `pg`, mêmes requêtes.
 */
function createPool() {
    if (process.env.DATABASE_URL) {
        const { Pool } = require('pg');
        return { pool: new Pool({ connectionString: process.env.DATABASE_URL }), mode: 'postgres' };
    }

    const { newDb } = require('pg-mem');
    const db = newDb({ autoCreateForeignKeyIndices: true });

    db.public.registerFunction({
        name: 'current_setting',
        args: [],
        returns: 'text',
        implementation: () => null,
    });

    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    db.public.none(schema);

    const { Pool } = db.adapters.createPg();
    return { pool: new Pool(), mode: 'pg-mem (simulation en mémoire)' };
}

module.exports = { createPool };

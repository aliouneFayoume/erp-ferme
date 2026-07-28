const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/**
 * Applique enable-rls.sql contre la base pointée par DATABASE_URL (jamais pg-mem).
 * Usage : node src/apply-rls.js
 */
async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL manquant — ce script ne doit être exécuté que contre une vraie base PostgreSQL.');
        process.exit(1);
    }
    const sql = fs.readFileSync(path.join(__dirname, 'enable-rls.sql'), 'utf-8');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        await pool.query(sql);
        console.log('Row-Level Security activée sur toutes les tables.');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Échec de l\'activation RLS:', err.message);
    process.exit(1);
});

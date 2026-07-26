// Script à usage unique : applique le schéma (et en option les données de démonstration) sur une
// vraie base PostgreSQL désignée par DATABASE_URL. Contrairement au mode pg-mem, une vraie base
// persiste entre les redémarrages du serveur — le schéma ne doit donc être appliqué qu'une fois.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { seed } = require('./seed');

async function migrate() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL doit être défini pour exécuter une migration sur une vraie base.');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const avecSeed = process.argv.includes('--seed');

    try {
        console.log('Connexion à la base...');
        await pool.query('SELECT 1');

        console.log('Application du schéma (server/src/schema.sql)...');
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
        await pool.query(schema);
        console.log('Schéma appliqué avec succès.');

        if (avecSeed) {
            console.log('Chargement des données de démonstration...');
            await seed(pool);
            console.log('Données de démonstration chargées.');
        }

        console.log('Migration terminée.');
        process.exit(0);
    } catch (err) {
        console.error('Échec de la migration:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

migrate();

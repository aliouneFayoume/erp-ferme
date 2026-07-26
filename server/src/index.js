require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { createPool } = require('./db');
const { seed } = require('./seed');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

async function main() {
    const { pool, mode } = createPool();
    console.log(`Mode base de données : ${mode}`);

    if (!process.env.DATABASE_URL) {
        await seed(pool);
        console.log('Données de démonstration chargées.');
    }

    app.use('/api/auth', require('./routes/auth')(pool));
    app.use('/api/dashboard', require('./routes/dashboard')(pool));
    app.use('/api/production', require('./routes/production')(pool));
    app.use('/api/catalogue', require('./routes/catalogue')(pool));
    app.use('/api/clients', require('./routes/clients')(pool));
    app.use('/api/commandes', require('./routes/commandes')(pool));
    app.use('/api/logistique', require('./routes/logistique')(pool));
    app.use('/api/finance', require('./routes/finance')(pool));
    app.use('/api/audit', require('./routes/audit')(pool));
    app.use('/api/utilisateurs', require('./routes/utilisateurs')(pool));
    app.use('/api/abonnements', require('./routes/abonnements')(pool));
    app.use('/api/comptabilite', require('./routes/comptabilite')(pool));

    app.get('/api/health', (req, res) => {
        res.json({ statut: 'En ligne', version: '1.0.0', mode, environnement: process.env.NODE_ENV || 'development' });
    });

    app.use(express.static(path.join(__dirname, '..', '..', 'web')));

    app.listen(PORT, () => {
        console.log('=========================================');
        console.log(`ERP Ferme Massla démarré sur http://localhost:${PORT}`);
        console.log('=========================================');
    });
}

main().catch((err) => {
    console.error('Erreur au démarrage du serveur:', err);
    process.exit(1);
});

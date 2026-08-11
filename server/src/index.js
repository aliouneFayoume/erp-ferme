require('dotenv').config();
const express = require('express');
// Doit être require() juste après express et AVANT toute déclaration de route : patche
// Router.prototype pour que le rejet d'une promesse dans un handler async soit transmis à next(err)
// au lieu de rester "unhandled" (Express 4 ne le fait pas nativement, contrairement à Express 5).
// Sans ça, un handler async qui rejette (ex: erreur base de données) fait planter tout le process
// Node — donc coupe TOUTES les fermes clientes — pour une seule requête HTTP malformée. Constat
// audit sécurité 2026-08-11 : reproduit avec /api/portail/login sur un body malformé.
require('express-async-errors');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { createPool } = require('./db');
const { seed } = require('./seed');

const app = express();
const PORT = process.env.PORT || 4000;

// En production, l'app est derrière un unique reverse proxy (nginx, voir docker-compose.yml) qui
// ajoute X-Forwarded-For. Sans ce réglage, express-rate-limit (utilisé par le login du portail
// client) refuse de faire confiance à cet en-tête et lève une erreur de validation sur chaque
// requête au lieu de calculer la limite par IP réelle du client.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
// PayDunya envoie ses notifications IPN en application/x-www-form-urlencoded, pas en JSON.
app.use(express.urlencoded({ extended: true }));

// CSP alignée sur les ressources externes réellement utilisées par le frontend (Leaflet via unpkg,
// tuiles OpenStreetMap) : aucune autre origine externe n'est chargée, donc pas de relâchement au-delà.
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", 'https://unpkg.com'],
                styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"], // styles inline ponctuels (frontend) + Leaflet
                imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org'],
                fontSrc: ["'self'"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
            },
        },
    })
);

// Filet de dernier recours : attrape ce qu'express-async-errors ne peut pas voir (une promesse
// rejetée en dehors du cycle requête/réponse — setInterval, callback fire-and-forget, etc.).
// Sans lui, Node 15+ tue le process sur un rejet non intercepté : on préfère journaliser et
// continuer plutôt que de couper toutes les fermes pour une erreur qui n'était pas fatale.
process.on('unhandledRejection', (err) => {
    console.error('Rejet de promesse non géré :', err);
});

async function main() {
    // Sans DATABASE_URL, createPool() bascule silencieusement sur pg-mem (base en mémoire, données
    // de démo, secret JWT par défaut — voir auth.js). Acceptable en développement local, mais servir
    // massla.sn dans cet état exposerait un secret public et des comptes de démo actifs pendant que
    // le déploiement se déclarerait "réussi" (le healthcheck ci-dessous répondait 200 dans les deux
    // cas). Constat audit développement 2026-08-11.
    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
        throw new Error(
            "DATABASE_URL doit être définie en production. Sans elle, le serveur démarrerait sur une base pg-mem en mémoire avec des données de démonstration et des secrets par défaut."
        );
    }

    const { pool, mode } = createPool();
    console.log(`Mode base de données : ${mode}`);

    if (!process.env.DATABASE_URL) {
        await seed(pool);
        console.log('Données de démonstration chargées.');
    }

    app.use('/api/public', require('./routes/public')(pool));
    app.use('/api/auth', require('./routes/auth')(pool));
    app.use('/api/inscription', require('./routes/inscription')(pool));
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
    app.use('/api/tickets', require('./routes/tickets')(pool));
    app.use('/api/portail', require('./routes/portail')(pool));
    app.use('/api/fournisseurs', require('./routes/fournisseurs')(pool));
    app.use('/api/parametres-paiement', require('./routes/parametres-paiement')(pool));
    app.use('/api/parametres-whatsapp', require('./routes/parametres-whatsapp')(pool));
    app.use('/api/plateforme', require('./routes/plateforme')(pool));

    // Interroge réellement la base plutôt que de renvoyer un texte statique : c'est cette route
    // qu'utilisent deploy/monitor.sh et l'étape de vérification post-déploiement (GitHub Actions).
    // Un pool épuisé, un mot de passe applicatif rejeté ou une base injoignable doivent se voir ici
    // en 503 — sinon la supervision reste verte pendant que chaque écran métier renvoie une erreur.
    // Constat audit systèmes 2026-08-11.
    app.get('/api/health', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ statut: 'En ligne', version: '1.0.0', mode, environnement: process.env.NODE_ENV || 'development' });
        } catch (err) {
            console.error('Health check : base de données injoignable.', err);
            res.status(503).json({ statut: 'Dégradé', erreur: 'Base de données injoignable.', mode });
        }
    });

    // Page publique de référencement local (pas de trailing slash requis, URL propre pour le partage).
    app.get('/decouvrir', (req, res) => {
        res.sendFile(path.join(__dirname, '..', '..', 'web', 'decouvrir.html'));
    });

    app.use(express.static(path.join(__dirname, '..', '..', 'web')));

    // Doit être le DERNIER app.use() : Express reconnaît un middleware d'erreur à sa signature à 4
    // arguments. Reçoit tout ce que next(err) transmet — donc, grâce à express-async-errors, tout
    // rejet d'un handler async. Sans ce filet, la même erreur ferait planter le process (voir plus
    // haut). Message générique côté client : jamais err.message brut (peut contenir des détails
    // internes — base de données, API tierces).
    app.use((err, req, res, next) => {
        console.error('Erreur non interceptée sur', req.method, req.originalUrl, ':', err);
        if (res.headersSent) return next(err);
        res.status(500).json({ erreur: 'Erreur interne du serveur.' });
    });

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

const helmet = require('helmet');

// CSP alignée sur les ressources externes réellement utilisées par le frontend (Leaflet via unpkg,
// tuiles de fond de carte Esri) : aucune autre origine externe n'est chargée, donc pas de
// relâchement au-delà. https://*.tile.openstreetmap.org gardé en plus d'Esri : ce serveur OSM a
// commencé à bloquer les requêtes de massla.sn (politique d'usage, voir migration des vues clients/
// logistique vers Esri) mais un navigateur peut avoir un vieux app.min.js en cache qui le référence
// encore juste après un déploiement — éviter un CSP-blocage en plus du blocage OSM le temps que le
// cache expire.
const directivesBase = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://unpkg.com'],
    styleSrc: ["'self'", 'https://unpkg.com', "'unsafe-inline'"], // styles inline ponctuels (frontend) + Leaflet
    // https://unpkg.com : icônes de marqueur par défaut de Leaflet (marker-icon.png,
    // marker-shadow.png), chargées via des url() relatives dans leaflet.css.
    imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://server.arcgisonline.com', 'https://unpkg.com'],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
};

// Pages publiques qui portent le suivi marketing (web/js/analytics.js : Google Analytics 4 + Meta
// Pixel). Seules elles ouvrent la CSP à Google et Meta : l'application (connexion, écrans de gestion,
// portail client) ne charge jamais de script tiers de suivi et garde la CSP stricte ci-dessus.
const PAGES_MARKETING = new Set(['/decouvrir', '/decouvrir.html', '/inscription', '/inscription.html']);

const directivesMarketing = {
    ...directivesBase,
    scriptSrc: [...directivesBase.scriptSrc, 'https://www.googletagmanager.com', 'https://connect.facebook.net'],
    imgSrc: [
        ...directivesBase.imgSrc,
        'https://www.googletagmanager.com',
        'https://www.google-analytics.com',
        'https://*.google-analytics.com',
        'https://*.g.doubleclick.net',
        'https://www.facebook.com',
    ],
    connectSrc: [
        ...directivesBase.connectSrc,
        'https://www.googletagmanager.com',
        'https://www.google-analytics.com',
        'https://*.google-analytics.com',
        'https://*.analytics.google.com',
        'https://*.g.doubleclick.net',
        'https://www.facebook.com',
        'https://connect.facebook.net',
    ],
};

const helmetBase = helmet({ contentSecurityPolicy: { directives: directivesBase } });
const helmetMarketing = helmet({ contentSecurityPolicy: { directives: directivesMarketing } });

/** Middleware unique : CSP marketing pour les pages ci-dessus, CSP stricte pour tout le reste. */
function securiteHeaders(req, res, next) {
    return (PAGES_MARKETING.has(req.path) ? helmetMarketing : helmetBase)(req, res, next);
}

module.exports = { securiteHeaders, directivesBase, directivesMarketing, PAGES_MARKETING };

// Regex des origines autorisées pour le CORS de l'API (server/src/index.js) — extraite dans son
// propre module pour être testable indépendamment du bootstrap de index.js (voir
// tests/cors.test.js). Un seul niveau de sous-domaine, cohérent avec le wildcard DNS/TLS
// *.massla.sn (un seul niveau, voir deploy/nginx.conf) et les slugs de ferme (routes/public.js).
module.exports = /^https:\/\/([a-z0-9-]+\.)?massla\.sn$/;

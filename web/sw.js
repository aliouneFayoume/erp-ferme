// Service worker : cache l'app shell pour un fonctionnement installable et hors-ligne
// (terrain PWA offline-first, cahier des charges §4). Les appels /api/* ne sont jamais
// mis en cache : ils doivent toujours refléter l'état réel du serveur.
const CACHE_NAME = 'erp-ferme-shell-v22';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/css/style.css',
  '/js/branding.js',
  '/js/api.js',
  '/js/offline-queue.js',
  '/js/app.js',
  '/js/views/dashboard.js',
  '/js/views/production.js',
  '/js/views/catalogue.js',
  '/js/views/clients.js',
  '/js/views/abonnements.js',
  '/js/views/commandes.js',
  '/js/views/fournisseurs.js',
  '/js/views/logistique.js',
  '/js/views/finance.js',
  '/js/views/comptabilite.js',
  '/js/views/utilisateurs.js',
  '/js/views/audit.js',
  '/js/views/tickets.js',
  '/js/views/parametres-paiement.js',
  '/js/views/plateforme.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    return; // laisse passer au réseau : API et requêtes non-GET jamais mises en cache
  }

  // Réseau d'abord : l'app shell (HTML/CSS/JS) doit toujours refléter la version courante du
  // serveur pour éviter qu'un front-end mis en cache ne désynchronise avec un contrat d'API
  // changé côté backend. Le cache ne sert que de secours si le réseau est indisponible
  // (terrain hors-ligne) — c'est là qu'est la valeur "offline-first" de ce service worker.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Service worker : cache l'app shell pour un fonctionnement installable et hors-ligne
// (terrain PWA offline-first, cahier des charges §4). Les appels /api/* ne sont jamais
// mis en cache : ils doivent toujours refléter l'état réel du serveur.
// v23 : le JS de l'app shell est maintenant fusionné+minifié en un seul fichier (web/build.js) —
// une seule entrée à tenir à jour au lieu d'une par vue (un ancien drift avait laissé paie.js hors
// de cette liste alors qu'index.html le chargeait déjà). Incrémenté pour que les clients déjà
// installés purgent l'ancien cache plutôt que de continuer à réclamer les anciens chemins par-vue.
const CACHE_NAME = 'erp-ferme-shell-v23';

const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/css/style.css',
  '/js/dist/app.min.js',
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

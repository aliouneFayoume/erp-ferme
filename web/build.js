// Fusionne + minifie le JS servi au navigateur avant la mise en production (protection basique
// contre la copie casuelle du frontend — voir le commentaire en tête de Dockerfile). N'exécute
// jamais ce script en dev normal : les fichiers sources dans web/js/ restent la référence pour
// éditer/déboguer, ce script ne fait que produire l'artefact livré en prod (web/js/dist/).
//
// Pas d'ES modules à résoudre ici : tout web/js/*.js utilise le pattern `window.X = ...` en
// scripts globaux (voir web/js/app.js, web/js/views/*.js) — une simple concaténation dans le même
// ordre que les <script> d'origine suffit, esbuild ne sert qu'à minifier le résultat.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const RACINE = __dirname;
const SORTIE = path.join(RACINE, 'js', 'dist');

// Un bundle par jeu de scripts réellement chargé par une page (voir <script> de chaque .html) —
// PAS un bundle unique global, les 4 pages ne chargent pas le même code.
const BUNDLES = {
  // index.html : branding, (Leaflet CDN — non inclus, reste un <script> externe), api,
  // offline-queue, les 16 vues (même ordre que index.html), puis app.js en dernier — cet ordre
  // relatif doit être conservé car chaque vue appelle window.showToast/fmt/esc/Modal/... définis
  // par app.js, seulement au moment du rendu (pas au chargement), donc l'ordre suffit tel quel.
  'app.min.js': [
    'js/branding.js',
    'js/api.js',
    'js/offline-queue.js',
    'js/views/dashboard.js',
    'js/views/production.js',
    'js/views/elevage.js',
    'js/views/catalogue.js',
    'js/views/clients.js',
    'js/views/abonnements.js',
    'js/views/commandes.js',
    'js/views/fournisseurs.js',
    'js/views/paie.js',
    'js/views/logistique.js',
    'js/views/finance.js',
    'js/views/comptabilite.js',
    'js/views/tickets.js',
    'js/views/parametres-paiement.js',
    'js/views/utilisateurs.js',
    'js/views/audit.js',
    'js/views/plateforme.js',
    'js/app.js',
  ],
  // decouvrir.html et inscription.html (dans <head>, avant tout le reste).
  'marketing.min.js': ['js/analytics.js'],
  // inscription.html, fin de <body> — séparé de marketing.min.js pour ne pas dupliquer
  // analytics.js dans les deux fichiers alors qu'il est déjà chargé une fois dans le <head>.
  'inscription.min.js': ['js/inscription.js'],
  // portail.html
  'portail.min.js': ['js/branding.js', 'js/portail.js'],
};

fs.mkdirSync(SORTIE, { recursive: true });

for (const [nomSortie, fichiers] of Object.entries(BUNDLES)) {
  const source = fichiers.map((f) => fs.readFileSync(path.join(RACINE, f), 'utf8')).join('\n;\n');
  const resultat = esbuild.transformSync(source, { minify: true, target: 'es2019', loader: 'js' });
  fs.writeFileSync(path.join(SORTIE, nomSortie), resultat.code);
  console.log(`${nomSortie} (${fichiers.length} fichier(s) source)`);
}

console.log(`Bundles générés dans ${SORTIE}`);

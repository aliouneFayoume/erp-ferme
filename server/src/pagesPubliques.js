// Pages publiques de massla.sn servies avec une URL propre (/aviculture plutôt que /aviculture.html). Source unique pour
// index.js (routes), csp.js (quelles pages portent le suivi d'audience) et les tests.
//
// Les fichiers HTML correspondants (web/<nom>.html) sont produits par outils/generer-pages-marketing.js à partir de
// web/decouvrir.html (en-tête, pied de page, formulaire de démo) et de outils/contenu-marketing.js (textes).
const PAGES_SECTEUR = ['aviculture', 'pisciculture', 'maraichage', 'elevage'];

// Pages légales : sans suivi d'audience, sauf la politique de confidentialité qui permet de gérer ce choix.
const PAGES_LEGALES = ['mentions', 'confidentialite'];
const PAGES_AVEC_SUIVI = [...PAGES_SECTEUR, 'confidentialite'];

module.exports = { PAGES_SECTEUR, PAGES_LEGALES, PAGES_AVEC_SUIVI, PAGES_PUBLIQUES: [...PAGES_SECTEUR, ...PAGES_LEGALES] };

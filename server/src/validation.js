// Audit sécurité 2026-08-11 (M2) : le nom d'un secteur était entièrement libre (juste .trim()) et
// affiché sans échappement à deux endroits du frontend (corrigé le même jour) — un secteur nommé
// avec du HTML/JS s'exécutait dans le navigateur de tout utilisateur de la ferme, et de tout
// superviseur en impersonation. L'échappement côté frontend est la défense qui compte réellement,
// mais restreindre le format ici retire la possibilité même d'y injecter des caractères dangereux,
// en défense en profondeur.
const NOM_SECTEUR_REGEX = /^[\p{L}\p{N} '’-]{1,50}$/u;

function nomSecteurValide(nom) {
    return typeof nom === 'string' && NOM_SECTEUR_REGEX.test(nom);
}

module.exports = { nomSecteurValide };

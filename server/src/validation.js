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

// Durcissement sécurité (migration-20) : 10 caractères min + les 4 classes de caractères. Appliqué
// à la création de tout compte (admin de ferme, utilisateur staff) et au changement de mot de passe
// (self-service ou reset admin) — jamais aux anciens mots de passe déjà en base, qui ne sont
// jamais revalidés rétroactivement.
const MOT_DE_PASSE_MIN_LONGUEUR = 10;

function motDePasseValide(mdp) {
    return (
        typeof mdp === 'string' &&
        mdp.length >= MOT_DE_PASSE_MIN_LONGUEUR &&
        /[a-z]/.test(mdp) &&
        /[A-Z]/.test(mdp) &&
        /[0-9]/.test(mdp) &&
        /[^A-Za-z0-9]/.test(mdp)
    );
}

/** Liste des règles non respectées, pour un message d'erreur précis. */
function motDePasseErreurs(mdp) {
    const valeur = typeof mdp === 'string' ? mdp : '';
    const erreurs = [];
    if (valeur.length < MOT_DE_PASSE_MIN_LONGUEUR) erreurs.push(`au moins ${MOT_DE_PASSE_MIN_LONGUEUR} caractères`);
    if (!/[a-z]/.test(valeur)) erreurs.push('une minuscule');
    if (!/[A-Z]/.test(valeur)) erreurs.push('une majuscule');
    if (!/[0-9]/.test(valeur)) erreurs.push('un chiffre');
    if (!/[^A-Za-z0-9]/.test(valeur)) erreurs.push('un caractère spécial');
    return erreurs;
}

module.exports = { nomSecteurValide, motDePasseValide, motDePasseErreurs, MOT_DE_PASSE_MIN_LONGUEUR };

// Programme d'affiliation (migration-46) : normalisation du code partenaire et rattachement d'une inscription.
// La commission elle-même (calculée sur les paiements réels) est dans routes/plateforme.js.
const { queryPreTenantPlateforme } = require('./auth');

const CODE_PARTENAIRE_MAX = 40;
const CODE_PARTENAIRE_REGEX = /^[A-Z0-9_-]{1,40}$/;
const MESSAGE_CODE_INCONNU = 'Code partenaire inconnu. Vérifiez-le ou laissez le champ vide.';

/**
 * Normalise un code partenaire saisi : trim + majuscules. Renvoie '' si rien n'a été saisi (le champ est facultatif),
 * `null` si la saisie est inutilisable (autre chose qu'un texte, caractère hors [A-Z0-9_-], plus de 40 caractères) — le
 * code n'atteint alors jamais la base. Les deux « mauvais cas » (inconnu / mal formé) donnent le même message au visiteur.
 */
function normaliserCodePartenaire(valeur) {
    if (valeur === undefined || valeur === null) return '';
    if (typeof valeur !== 'string') return null;
    const code = valeur.trim().toUpperCase();
    if (code === '') return '';
    return CODE_PARTENAIRE_REGEX.test(code) ? code : null;
}

/**
 * Partenaire ACTIF portant ce code (déjà normalisé), ou null. S'exécute avant tout contexte de ferme (l'inscription n'en a
 * pas encore) : les tables d'affiliation étant réservées au superviseur plateforme, la lecture passe par le contexte
 * plateforme de queryPreTenantPlateforme — avec une recherche paramétrée sur le code, jamais une liste.
 */
async function trouverPartenaireActif(pool, code) {
    const r = await queryPreTenantPlateforme(pool, `SELECT id, code FROM partenaires WHERE code = $1 AND actif = TRUE`, [code]);
    return r.rows[0] || null;
}

module.exports = { normaliserCodePartenaire, trouverPartenaireActif, CODE_PARTENAIRE_MAX, MESSAGE_CODE_INCONNU };

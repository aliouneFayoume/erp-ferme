// Module Ostréiculture (cahier des charges v0.1, V1) — constantes et petites règles partagées par les routes de production,
// la ferme d'essai et les tests. Les listes ci-dessous sont des valeurs de départ tirées du rapport FAO FISH4ACP (2023) :
// elles restent à valider avec l'ANA et les GIE (types de structure, destinations, calibres).

const SECTEUR_OSTREICULTURE = 'Ostréiculture';

const TYPES_STRUCTURE = ['GUIRLANDE', 'POCHE', 'TABLE', 'LIGNE', 'COLLECTEUR', 'AUTRE'];
const ORIGINES_LOT = ['CAPTAGE', 'ACHAT', 'CUEILLETTE'];
const DESTINATIONS_RECOLTE = ['FRAIS', 'TRANSFORMATION', 'FAMILLE'];
// Entretien d'une structure noté lors d'un relevé : nettoyage de l'encrassement, dédoublage (baisse de la densité),
// changement de hauteur sur l'estran.
const ENTRETIENS = ['NETTOYAGE', 'DEDOUBLAGE', 'HAUTEUR'];

/**
 * Mise en service (fail-closed, même philosophie que ESSAI_AUTONOME_ACTIF) : tant que OSTREICULTURE_ACTIF n'est pas défini,
 * la filière n'est ni proposée ni acceptée à l'inscription à l'essai.
 *   'true' -> publique (proposée sur la page d'inscription)
 *   'lien' -> cachée : acceptée uniquement pour qui connaît le lien (?filiere=ostreiculture), jamais listée
 *   autre  -> fermée
 */
function modeOstreiculture() {
    if (process.env.OSTREICULTURE_ACTIF === 'true') return 'public';
    if (process.env.OSTREICULTURE_ACTIF === 'lien') return 'lien';
    return 'ferme';
}

function ostreiculturePermise() {
    return modeOstreiculture() !== 'ferme';
}

/** Valeur de la liste, ou null (absente ou hors liste : ignorée plutôt que refusée, une donnée de terrain ne se perd pas pour ça). */
function dansListeOuNull(valeur, liste) {
    const v = String(valeur || '').trim().toUpperCase();
    return liste.includes(v) ? v : null;
}

/** « NETTOYAGE,DEDOUBLAGE » à partir d'un tableau ou d'une chaîne ; null si rien de valide. */
function normaliserEntretien(valeur) {
    const brut = Array.isArray(valeur) ? valeur : String(valeur || '').split(',');
    const retenus = [...new Set(brut.map((v) => String(v).trim().toUpperCase()).filter((v) => ENTRETIENS.includes(v)))];
    return retenus.length ? retenus.join(',') : null;
}

/** Nombre fini >= 0, ou null. */
function nombreOuNull(valeur) {
    if (valeur === undefined || valeur === null || valeur === '') return null;
    const n = Number(valeur);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Entier >= 0, ou null. */
function entierOuNull(valeur) {
    const n = nombreOuNull(valeur);
    return n === null ? null : Math.round(n);
}

module.exports = {
    SECTEUR_OSTREICULTURE,
    TYPES_STRUCTURE,
    ORIGINES_LOT,
    DESTINATIONS_RECOLTE,
    ENTRETIENS,
    modeOstreiculture,
    ostreiculturePermise,
    dansListeOuNull,
    normaliserEntretien,
    nombreOuNull,
    entierOuNull,
};

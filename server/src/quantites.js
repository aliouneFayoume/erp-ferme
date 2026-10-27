/**
 * Validation des quantités saisies par l'utilisateur (commandes, abonnements) : entier strictement
 * positif, plafonné pour éviter les valeurs absurdes (débordement, NaN, texte, négatif qui
 * « créerait » du stock en réservant une quantité négative).
 */
const QUANTITE_MAX = 1000000;

function estQuantiteValide(valeur) {
    if (typeof valeur === 'string') {
        if (!/^\d+$/.test(valeur.trim())) return false;
        valeur = Number(valeur);
    }
    return Number.isInteger(valeur) && valeur > 0 && valeur <= QUANTITE_MAX;
}

module.exports = { estQuantiteValide, QUANTITE_MAX };

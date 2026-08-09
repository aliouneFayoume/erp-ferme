/**
 * Sous-domaine (<slug>.massla.sn) dérivé automatiquement du nom de la ferme à sa création — voir
 * routes/public.js pour la résolution inverse (Host header -> ferme) et le commentaire sur
 * organisations.slug dans schema.sql pour la portée exacte (image de marque uniquement).
 */
function retirerDiacritiques(texte) {
    const NFD = texte.normalize('NFD');
    let resultat = '';
    for (const caractere of NFD) {
        const point = caractere.codePointAt(0);
        // Plage Unicode "Combining Diacritical Marks" (U+0300 à U+036F) : ce sont les accents
        // séparés par normalize('NFD') (é -> e + accent aigu séparé), à retirer un par un.
        if (point >= 0x0300 && point <= 0x036f) continue;
        resultat += caractere;
    }
    return resultat;
}

function genererSlugBase(nom) {
    const base = retirerDiacritiques(nom)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    return base || 'ferme';
}

/** Doit être appelé sur une connexion dédiée (client, pas pool) pour rester cohérent avec la
 * transaction appelante — voir creerFerme.js. */
async function genererSlugUnique(client, nom) {
    const base = genererSlugBase(nom);
    let candidat = base;
    let suffixe = 2;
    while (true) {
        const existant = await client.query(`SELECT 1 FROM organisations WHERE slug = $1`, [candidat]);
        if (existant.rows.length === 0) return candidat;
        candidat = `${base}-${suffixe}`;
        suffixe += 1;
    }
}

module.exports = { genererSlugBase, genererSlugUnique };

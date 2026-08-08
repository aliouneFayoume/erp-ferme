// Chiffrement au repos des identifiants sensibles appartenant à un tenant (clés d'agrégateur de
// paiement notamment) — ces valeurs ne doivent jamais être lisibles en clair dans un dump de base
// ou un accès direct à Postgres, contrairement à la plupart des autres colonnes de l'application.
// AES-256-GCM : chiffrement authentifié (détecte toute altération du texte chiffré au déchiffrement).
const crypto = require('crypto');

// Même convention que JWT_SECRET (voir auth.js) : une vraie base de données implique un
// déploiement réel, qui ne doit jamais tourner avec une clé de secours connue de tous.
if (!process.env.CREDENTIALS_ENCRYPTION_KEY && process.env.DATABASE_URL) {
    throw new Error(
        'CREDENTIALS_ENCRYPTION_KEY doit être défini explicitement dès qu\'une vraie base de données (DATABASE_URL) est configurée.'
    );
}
if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
    console.warn('⚠️  CREDENTIALS_ENCRYPTION_KEY non défini : clé de démonstration utilisée (pg-mem uniquement, jamais en production).');
}

// Dérive une clé AES-256 (32 octets) à partir de la variable d'environnement, quelle que soit sa
// longueur d'origine — évite d'exiger un format précis (hex/base64) côté configuration du VPS.
const KEY = crypto.createHash('sha256').update(process.env.CREDENTIALS_ENCRYPTION_KEY || 'dev-encryption-key-simulation-ferme-massla').digest();

const ALGORITHME = 'aes-256-gcm';
const IV_LONGUEUR = 12; // taille recommandée pour GCM

/** Chiffre une chaîne en clair ; renvoie une chaîne base64 auto-suffisante (iv + tag + données). */
function chiffrer(texteClair) {
    const iv = crypto.randomBytes(IV_LONGUEUR);
    const cipher = crypto.createCipheriv(ALGORITHME, KEY, iv);
    const chiffre = Buffer.concat([cipher.update(String(texteClair), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, chiffre]).toString('base64');
}

/** Déchiffre une chaîne produite par chiffrer(). Lève une erreur si la donnée a été altérée. */
function dechiffrer(texteChiffre) {
    const donnees = Buffer.from(texteChiffre, 'base64');
    const iv = donnees.subarray(0, IV_LONGUEUR);
    const tag = donnees.subarray(IV_LONGUEUR, IV_LONGUEUR + 16);
    const chiffre = donnees.subarray(IV_LONGUEUR + 16);
    const decipher = crypto.createDecipheriv(ALGORITHME, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(chiffre), decipher.final()]).toString('utf8');
}

module.exports = { chiffrer, dechiffrer };

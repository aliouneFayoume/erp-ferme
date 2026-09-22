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

/**
 * Normalise un numéro de téléphone/WhatsApp saisi librement en format international (+ suivi des
 * chiffres, sans espace), ou renvoie null s'il est invalide. Règles :
 * - "+221 77 000 00 00", "00221 77 000 00 00", "221770000000" → "+221770000000" ;
 * - 9 chiffres commençant par 70/75/76/77/78 (mobile sénégalais saisi sans indicatif) → préfixe +221 ;
 * - tout autre pays : l'indicatif est obligatoire ("+" ou "00" devant), 8 à 15 chiffres au total (E.164) ;
 * - un numéro +221 doit avoir exactement 9 chiffres nationaux.
 * Ne prouve pas que le numéro existe sur WhatsApp ni qu'il appartient à la bonne personne : seulement
 * qu'il est bien formé (cas constaté 2026-09-20 : un numéro à 9 chiffres sans indicatif).
 * Copie côté navigateur : web/js/contact-decouvrir.js (le serveur reste l'autorité).
 */
function normaliserTelephone(saisie) {
    if (typeof saisie !== 'string') return null;
    const texte = saisie.trim();
    if (!/^[+\d(][\d\s().-]*$/.test(texte)) return null;
    let chiffres = texte.replace(/\D/g, '');
    if (texte.startsWith('+')) {
        // indicatif déjà fourni
    } else if (chiffres.startsWith('00')) {
        chiffres = chiffres.slice(2);
    } else if (chiffres.length === 9 && /^7[05678]/.test(chiffres)) {
        chiffres = `221${chiffres}`;
    } else if (/^221\d{9}$/.test(chiffres)) {
        // "221 77 000 00 00" sans le +
    } else {
        return null;
    }
    if (chiffres.length < 8 || chiffres.length > 15) return null;
    if (chiffres.startsWith('0')) return null; // un indicatif pays ne commence jamais par 0
    if (chiffres.startsWith('221') && chiffres.length !== 12) return null;
    return `+${chiffres}`;
}

// Domaines jetables/temporaires les plus répandus (boîte qui s'autodétruit en quelques minutes) :
// un vrai client n'a aucune raison d'en utiliser un pour une demande qu'on doit pouvoir recontacter.
const DOMAINES_JETABLES = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.biz', 'sharklasers.com',
    'yopmail.com', 'yopmail.fr', 'yopmail.net', '10minutemail.com', '10minutemail.net', 'tempmail.com',
    'temp-mail.org', 'trashmail.com', 'throwawaymail.com', 'fakeinbox.com', 'getnada.com', 'dispostable.com',
    'maildrop.cc', 'mintemail.com', 'discard.email', 'moakt.com', 'emailondeck.com', 'mohmal.com',
]);

// Domaines réservés à la documentation/aux exemples (RFC 2606) : jamais une vraie boîte.
const DOMAINES_EXEMPLE = new Set(['example.com', 'example.org', 'example.net', 'example.edu', 'test.com']);

// Parties locales manifestement bidon : mot de test, remplissage clavier, placeholder générique.
const LOCAL_PARTS_SUSPECTES = new Set([
    'test', 'testtest', 'exemple', 'example', 'asdf', 'asdfgh', 'qwerty', 'azerty', 'admin', 'administrateur',
    'noreply', 'no-reply', 'abc', 'abcd', 'abcdef', 'xxx', 'xxxx', 'verif', 'verification', 'sample', 'demo',
    'user', 'utilisateur', 'foo', 'bar', 'foobar', 'toto', 'titi', '123', '1234', '123456', 'aaa', 'aaaa',
]);

/**
 * Détecte une adresse email au format valide mais manifestement fictive/de test ("farfelue") :
 * domaine jetable ou réservé à la documentation, notre propre domaine (aucun visiteur externe ne
 * peut légitimement écrire depuis @massla.sn), partie locale bidon (test/asdf/admin/...), ou une
 * même lettre/chiffre répété(e) ("aaaaaa@..."). Ne remplace pas la vérification du format lui-même
 * (EMAIL_REGEX dans routes/contact.js) ni une preuve que la boîte existe réellement — seulement un
 * filtre contre les demandes visiblement jouées (cas constatés : verif@example.com, test-ne-pas-
 * traiter@massla.sn). Copie de l'esprit de normaliserTelephone ci-dessus, mais pour l'email.
 */
function emailFarfelue(saisie) {
    const m = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(String(saisie || '').trim());
    if (!m) return true; // format déjà invalide : de toute façon refusé par EMAIL_REGEX
    const local = m[1].toLowerCase();
    const domaine = m[2].toLowerCase();
    if (DOMAINES_JETABLES.has(domaine) || DOMAINES_EXEMPLE.has(domaine)) return true;
    if (domaine === 'massla.sn' || domaine.endsWith('.massla.sn')) return true;
    if (LOCAL_PARTS_SUSPECTES.has(local)) return true;
    if (/^(.)\1*$/.test(local)) return true; // une seule lettre/chiffre répété(e), ex. "aaaaaa"
    return false;
}

module.exports = { nomSecteurValide, motDePasseValide, motDePasseErreurs, MOT_DE_PASSE_MIN_LONGUEUR, normaliserTelephone, emailFarfelue };

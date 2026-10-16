// MFA (migration-20) : TOTP (application d'authentification) ou code à usage unique par WhatsApp,
// au choix de l'utilisateur. Un seul flux "en vol" à la fois par utilisateur (colonnes mfa_code_*
// sur utilisateurs, partagées entre le défi de connexion WhatsApp et la confirmation d'activation).
const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { chiffrer, dechiffrer } = require('./credentials');
const { envoyerMessageWhatsapp } = require('./whatsapp');
const { modeleAuthentification, composantsCodeAuthentification } = require('./essaiAutonome');

// --- TOTP --------------------------------------------------------------------

function genererSecretTotp() {
    return authenticator.generateSecret();
}

async function genererQrCodeTotp(email, secret, organisationNom) {
    const otpauthUrl = authenticator.keyuri(email, organisationNom ? `Massla · ${organisationNom}` : 'Massla', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    return { otpauthUrl, qrCodeDataUrl };
}

function verifierTotp(code, secretChiffre) {
    const secret = dechiffrer(secretChiffre);
    return authenticator.check(String(code || ''), secret);
}

// --- Code WhatsApp -------------------------------------------------------------

const DUREE_CODE_MINUTES = 5;
const MAX_TENTATIVES_CODE = 5;

// Mise en attente volontaire (2026-08-27) : le numéro WhatsApp Business de production est bloqué
// et le template Meta "Authentication" n'est pas encore approuvé — activer cette méthode côté
// utilisateurs donnerait une fonctionnalité visiblement cassée. Coupée par défaut (fail-closed,
// même philosophie que estConfigure() dans whatsapp.js/email.js) ; repasser à 'true' dans
// l'environnement de production une fois le numéro débloqué et le template approuvé — aucun
// changement de code nécessaire, tout le reste (TOTP, mot de passe, vérification email) n'en
// dépend pas et continue de se déployer normalement.
function whatsappMfaActif() {
    return process.env.MFA_WHATSAPP_ACTIF === 'true';
}

function genererCodeWhatsapp() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    return { code, hash: hashCode(code), expireLe: new Date(Date.now() + DUREE_CODE_MINUTES * 60 * 1000) };
}

function hashCode(code) {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

/**
 * Toujours les identifiants WhatsApp GLOBAUX (Massla) : c'est une fonctionnalité de sécurité
 * plateforme, pas une communication au nom de la ferme du destinataire — contrairement aux
 * relances de facturation (finance.js), qui elles utilisent la config par tenant si présente.
 *
 * Utilise le modèle Meta « Authentication » (WHATSAPP_TEMPLATE_AUTH_NOM, le même que le code de connexion de l'essai
 * autonome, voir essaiAutonome.js) — JAMAIS le modèle de relance de facture de la config globale : il enverrait le code à la
 * place d'un montant. Sans ce modèle configuré, l'envoi échoue net (l'appelant journalise l'erreur) plutôt que d'envoyer un
 * message faux ; TOTP reste pleinement fonctionnel indépendamment.
 */
async function envoyerCodeWhatsapp(numero, code) {
    const modele = modeleAuthentification();
    if (!modele.nom) {
        throw new Error("Modèle WhatsApp « Authentication » non configuré (WHATSAPP_TEMPLATE_AUTH_NOM) : code MFA non envoyé.");
    }
    await envoyerMessageWhatsapp(numero, { modele, composants: composantsCodeAuthentification(code) });
}

module.exports = {
    genererSecretTotp,
    genererQrCodeTotp,
    verifierTotp,
    genererCodeWhatsapp,
    hashCode,
    envoyerCodeWhatsapp,
    whatsappMfaActif,
    DUREE_CODE_MINUTES,
    MAX_TENTATIVES_CODE,
};

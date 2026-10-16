// Essai autonome (Easystart phase 3, migration-35) : inscription par téléphone + connexion par code WhatsApp.
// Ce module ne contient que la mécanique du code à usage unique et son envoi ; les routes sont dans routes/essai.js,
// la création de la ferme dans creerFermeEssai.js.
const crypto = require('crypto');
const { envoyerMessageWhatsapp, estConfigure: whatsappConfigure } = require('./whatsapp');

const DUREE_CODE_MINUTES = 10;
const MAX_TENTATIVES_CODE = 5;
// Délai minimal entre deux envois de code au même numéro : un code WhatsApp est un message facturé par Meta, et un
// numéro ciblé ne doit pas pouvoir être inondé de messages.
const DELAI_RENVOI_SECONDES = 60;

/**
 * Interrupteur de mise en service (fail-closed, même philosophie que MFA_WHATSAPP_ACTIF dans mfa.js) : tant que
 * ESSAI_AUTONOME_ACTIF n'est pas 'true', les routes /api/essai/* répondent 503 et aucune page ne propose l'essai.
 */
function essaiAutonomeActif() {
    return process.env.ESSAI_AUTONOME_ACTIF === 'true';
}

/**
 * Modèle Meta de catégorie « Authentication » (distinct du modèle de relance `rappel_facture`) : WHATSAPP_TEMPLATE_AUTH_NOM
 * / WHATSAPP_TEMPLATE_AUTH_LANGUE. Sans lui, un code ne peut pas être envoyé : Meta refuse tout message initié par
 * l'entreprise hors modèle approuvé.
 */
function modeleAuthentification() {
    return { nom: process.env.WHATSAPP_TEMPLATE_AUTH_NOM || '', langue: process.env.WHATSAPP_TEMPLATE_AUTH_LANGUE || 'fr' };
}

/** Local sans vraie base (pg-mem) : pas de WhatsApp réel, le code est écrit dans la console du serveur. */
function modeSimulation() {
    return !process.env.DATABASE_URL && !whatsappConfigure();
}

/** L'essai autonome peut-il réellement fonctionner maintenant ? (interrupteur + modèle Meta + WhatsApp configuré) */
function essaiAutonomeDisponible() {
    if (!essaiAutonomeActif()) return false;
    if (modeSimulation()) return true;
    return !!modeleAuthentification().nom && whatsappConfigure();
}

function hashCode(code) {
    return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function genererCodeConnexion() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    return { code, hash: hashCode(code), expireLe: new Date(Date.now() + DUREE_CODE_MINUTES * 60 * 1000) };
}

/** Comparaison à temps constant de deux empreintes SHA-256 hexadécimales (64 caractères). */
function codeCorrespond(codeSaisi, hashAttendu) {
    if (!hashAttendu) return false;
    const a = Buffer.from(hashCode(codeSaisi), 'hex');
    const b = Buffer.from(String(hashAttendu), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Envoie le code par WhatsApp avec le modèle « Authentication ». Un modèle de ce type porte le code à deux endroits : dans le
 * corps du message ET dans le bouton « Copier le code » — Meta exige les deux paramètres.
 */
async function envoyerCodeConnexion(telephone, code) {
    if (modeSimulation()) {
        console.log(`[essai autonome — simulation] code de connexion pour ${telephone} : ${code}`);
        return;
    }
    await envoyerMessageWhatsapp(telephone, {
        modele: modeleAuthentification(),
        composants: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
    });
}

module.exports = {
    DUREE_CODE_MINUTES,
    MAX_TENTATIVES_CODE,
    DELAI_RENVOI_SECONDES,
    essaiAutonomeActif,
    essaiAutonomeDisponible,
    modeleAuthentification,
    genererCodeConnexion,
    codeCorrespond,
    envoyerCodeConnexion,
};

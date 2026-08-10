// Relances de facturation SaaS via WhatsApp Business Cloud API (Meta) — voir
// server/README.md pour la configuration des variables d'environnement. Même philosophie que
// paydunya.js : une intégration non configurée échoue proprement (erreur claire) plutôt que
// d'échouer silencieusement ou de simuler un envoi.
const WHATSAPP_API_VERSION = 'v21.0';

function lireConfig() {
    return {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        // "hello_world"/"en_US" par défaut : le seul modèle disponible avant l'approbation par Meta
        // d'un modèle personnalisé pour la relance de facture — voir DEPLOIEMENT.md pour la marche à
        // suivre une fois le vrai modèle approuvé (il suffit de changer ces deux variables, aucun
        // changement de code).
        templateNom: process.env.WHATSAPP_TEMPLATE_NOM || 'hello_world',
        templateLangue: process.env.WHATSAPP_TEMPLATE_LANGUE || 'en_US',
    };
}

function estConfigure() {
    const { accessToken, phoneNumberId } = lireConfig();
    return !!(accessToken && phoneNumberId);
}

/**
 * Envoie un message WhatsApp basé sur un modèle pré-approuvé par Meta — obligatoire pour un message
 * initié par l'entreprise (hors de la fenêtre de service client de 24h), ce qui est toujours le cas
 * pour une relance de facturation. `composants` (optionnel) correspond aux paramètres du modèle une
 * fois qu'un vrai modèle personnalisé (avec variables : nom de la ferme, montant, échéance) est
 * approuvé — voir la documentation Meta sur les "template components".
 */
async function envoyerMessageWhatsapp(telephone, { composants } = {}) {
    const config = lireConfig();
    if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("Intégration WhatsApp non configurée (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID manquants).");
    }
    const numero = String(telephone).replace(/[^0-9]/g, '');
    if (!numero) {
        throw new Error('Numéro de téléphone invalide.');
    }

    const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: numero,
            type: 'template',
            template: {
                name: config.templateNom,
                language: { code: config.templateLangue },
                ...(composants ? { components: composants } : {}),
            },
        }),
    });

    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    if (!res.ok) {
        const message = data?.error?.message || `Erreur HTTP ${res.status}`;
        throw new Error(`Échec de l'envoi WhatsApp : ${message}`);
    }
    return data;
}

module.exports = { envoyerMessageWhatsapp, estConfigure };

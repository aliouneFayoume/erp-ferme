// Relances de facturation SaaS via WhatsApp Business Cloud API (Meta) — voir
// server/README.md pour la configuration des variables d'environnement. Même philosophie que
// paydunya.js : une intégration non configurée échoue proprement (erreur claire) plutôt que
// d'échouer silencieusement ou de simuler un envoi.
const WHATSAPP_API_VERSION = 'v21.0';
// Audit systèmes 2026-08-11 (item #10) : même raisonnement que paydunya.js — pas de timeout par
// défaut sur fetch, un Graph API muet bloquerait indéfiniment la requête de relance.
const DELAI_MAX_MS = 10000;

/**
 * Identifiants globaux (server/.env) — ceux de Ferme Massla elle-même (organisations.est_plateforme,
 * voir routes/finance.js). Toute AUTRE organisation doit fournir sa PROPRE config (voir
 * whatsappConfig.js / routes/parametres-whatsapp.js), jamais ce fallback.
 */
function lireConfigGlobale() {
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
    const { accessToken, phoneNumberId } = lireConfigGlobale();
    return !!(accessToken && phoneNumberId);
}

/**
 * Envoie un message WhatsApp basé sur un modèle pré-approuvé par Meta — obligatoire pour un message
 * initié par l'entreprise (hors de la fenêtre de service client de 24h), ce qui est toujours le cas
 * pour une relance de facturation. `composants` (optionnel) correspond aux paramètres du modèle une
 * fois qu'un vrai modèle personnalisé (avec variables : nom de la ferme, montant, échéance) est
 * approuvé — voir la documentation Meta sur les "template components". `config` (optionnel) permet
 * à l'appelant de fournir les identifiants d'UNE organisation précise (déjà déchiffrés via
 * whatsappConfig.js) au lieu des identifiants globaux de Massla — c'est l'appelant qui décide
 * lesquels utiliser, ce module ne fait aucune hypothèse sur le tenant.
 */
async function envoyerMessageWhatsapp(telephone, { composants, config: configFournie } = {}) {
    const config = configFournie || lireConfigGlobale();
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
        signal: AbortSignal.timeout(DELAI_MAX_MS),
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

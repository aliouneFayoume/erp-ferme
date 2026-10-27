const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../auth');
const { demanderConseil, estConfigure } = require('../assistant');

const MAX_MESSAGES = 20;
const MAX_LONGUEUR_MESSAGE = 2000;
// Coût : seuls les derniers échanges sont envoyés au modèle (chaque appel facture tout l'historique).
const MAX_MESSAGES_ENVOYES = 6;
const MAX_CARACTERES_ENVOYES = 4000;

// Rate-limit PAR TENANT (ferme), pas par IP — contrairement à toutes les autres limites du code
// (auth.js/inscription.js/portail.js/finance.js), qui sont pré-authentification. Ici l'utilisateur
// est déjà identifié : la clé doit être le tenant pour garantir qu'une ferme ne peut jamais épuiser
// le quota d'une autre ferme indépendante partageant la même app. 50/jour borne le pire cas à
// quelques dizaines de centimes/mois par ferme (voir mémoire erp_ferme_ai_assistant_project).
const limiteurAssistant = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user.tenant_id),
    message: { erreur: "Limite quotidienne de questions à l'assistant atteinte pour votre ferme. Réessayez demain." },
});

function messagesValides(messages) {
    // Le dernier message doit être la question de l'utilisateur.
    if (Array.isArray(messages) && messages.length > 0 && (!messages[messages.length - 1] || messages[messages.length - 1].role !== 'user')) return false;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return false;
    return messages.every(
        (m) => m && (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' && m.content.trim().length > 0 && m.content.length <= MAX_LONGUEUR_MESSAGE
    );
}

/**
 * Réduit l'historique : 6 derniers messages, 4 000 caractères au total (on retire les plus anciens),
 * en gardant toujours le dernier message de l'utilisateur, et en commençant par un message 'user'.
 */
function tronquerHistorique(messages) {
    let garde = messages.slice(-MAX_MESSAGES_ENVOYES);
    const total = (liste) => liste.reduce((somme, m) => somme + m.content.length, 0);
    while (garde.length > 1 && total(garde) > MAX_CARACTERES_ENVOYES) garde = garde.slice(1);
    while (garde.length > 1 && garde[0].role !== 'user') garde = garde.slice(1);
    return garde.map((m) => ({ role: m.role, content: m.content }));
}

// Validation AVANT le limiteur : une requête invalide (rejetée en 400) ne consomme pas le quota quotidien.
function validerCorps(req, res, next) {
    if (!estConfigure()) {
        return res.status(503).json({ erreur: "L'assistant IA n'est pas configuré." });
    }
    if (!req.body || !messagesValides(req.body.messages)) {
        return res.status(400).json({ erreur: 'Historique de messages invalide.' });
    }
    next();
}

module.exports = function assistantRoutes(pool) {
    const router = express.Router();

    // Aucune restriction de rôle : conseil agricole utile à tous les profils, même pattern que
    // l'onglet "Mon compte" dans web/js/app.js.
    router.post('/chat', requireAuth(pool), validerCorps, limiteurAssistant, async (req, res) => {
        try {
            const reponse = await demanderConseil(tronquerHistorique(req.body.messages));
            res.json({ reponse });
        } catch (err) {
            console.error(err);
            res.status(502).json({ erreur: "L'assistant IA n'a pas pu répondre pour le moment." });
        }
    });

    return router;
};

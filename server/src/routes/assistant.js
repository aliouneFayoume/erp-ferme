const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, queryPreTenantPlateforme } = require('../auth');
const { logAudit } = require('../audit');
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

// Plafond GLOBAL (toutes fermes confondues) : le plafond par ferme ci-dessus borne chaque ferme, pas la facture totale
// (100 fermes x 50 appels = 5 000 appels/jour). Compté dans le journal d'audit (durable : survit à un redémarrage du serveur,
// contrairement au compteur en mémoire du limiteur par ferme). Une valeur absente ou invalide retombe sur le défaut, jamais sur 0.
const PLAFOND_GLOBAL_DEFAUT = 500;
function plafondGlobalQuotidien() {
    const n = Number(process.env.ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL);
    return Number.isInteger(n) && n > 0 ? n : PLAFOND_GLOBAL_DEFAUT;
}

/** Nombre d'appels à l'assistant des dernières 24 h, toutes fermes (lecture cross-tenant réservée au contexte plateforme). */
async function appelsGlobauxDernieres24h(pool) {
    const res = await queryPreTenantPlateforme(
        pool,
        `SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'assistant' AND action = 'CHAT' AND cree_le > $1`,
        [new Date(Date.now() - 24 * 60 * 60 * 1000)]
    );
    return res.rows[0].n;
}

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
            if ((await appelsGlobauxDernieres24h(pool)) >= plafondGlobalQuotidien()) {
                return res.status(429).json({ erreur: "L'assistant IA a atteint sa limite quotidienne pour toute la plateforme. Réessayez demain." });
            }
            // Journalisé AVANT l'appel : un appel qui échoue côté fournisseur peut quand même avoir été facturé.
            await logAudit(req.db, { req, table: 'assistant', action: 'CHAT', userId: req.user.id, tenantId: req.user.tenant_id });
            const reponse = await demanderConseil(tronquerHistorique(req.body.messages));
            res.json({ reponse });
        } catch (err) {
            console.error(err);
            res.status(502).json({ erreur: "L'assistant IA n'a pas pu répondre pour le moment." });
        }
    });

    return router;
};

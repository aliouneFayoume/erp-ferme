const express = require('express');
const rateLimit = require('express-rate-limit');
const email = require('../email');
const { normaliserTelephone } = require('../validation');

const PREFERENCES_VALIDES = ['whatsapp', 'telephone', 'email'];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Public, pas de compte à ce stade — le seul garde-fou contre le spam est le rate-limit, plus
// strict que la connexion (auth.js) mais plus large que l'inscription (une vraie visite peut
// légitimement renvoyer le formulaire après une faute de frappe).
const limiteurContact = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de demandes. Réessayez plus tard.' },
});

module.exports = function contactRoutes(pool) {
    const router = express.Router();

    /**
     * Formulaire de contact public (massla.sn/decouvrir, boutons "Démonstration gratuite") — se contente de
     * notifier l'équipe par email, aucune donnée persistée en base (pas de table dédiée, volume de
     * demandes bien trop faible pour le justifier ; voir email.envoyerNotificationContact).
     */
    router.post('/', limiteurContact, async (req, res) => {
        const nom = String(req.body.nom || '').trim();
        const emailVisiteur = String(req.body.email || '').trim();
        const whatsapp = normaliserTelephone(String(req.body.whatsapp || ''));
        const preference = String(req.body.preference || '').trim();

        if (!nom || nom.length > 100) {
            return res.status(400).json({ erreur: 'Nom et prénom requis.' });
        }
        if (!EMAIL_REGEX.test(emailVisiteur)) {
            return res.status(400).json({ erreur: 'Adresse email invalide.' });
        }
        if (!whatsapp) {
            return res.status(400).json({ erreur: "Numéro WhatsApp invalide. Indiquez-le avec l'indicatif du pays, par exemple +221 77 000 00 00." });
        }
        // Facultative : le formulaire actuel ne la demande plus, mais un ancien client (page en cache) peut
        // encore l'envoyer. Absente = ignorée ; présente mais hors liste = toujours refusée.
        if (preference && !PREFERENCES_VALIDES.includes(preference)) {
            return res.status(400).json({ erreur: 'Préférence de contact invalide.' });
        }

        if (!email.estConfigure()) {
            return res.status(503).json({ erreur: 'Service de contact indisponible pour le moment. Écrivez-nous directement sur WhatsApp.' });
        }

        try {
            await email.envoyerNotificationContact({ nom, email: emailVisiteur, whatsapp, preference });
            res.status(201).json({ message: 'Demande envoyée. Nous vous recontactons rapidement.' });
        } catch (err) {
            console.error(err);
            res.status(502).json({ erreur: "Échec de l'envoi. Écrivez-nous directement sur WhatsApp." });
        }
    });

    return router;
};

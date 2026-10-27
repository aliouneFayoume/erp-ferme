const express = require('express');
const rateLimit = require('express-rate-limit');
const email = require('../email');
const { normaliserTelephone, emailFarfelue, emailFormatValide } = require('../validation');

const PREFERENCES_VALIDES = ['whatsapp', 'telephone', 'email'];
// D'où vient la demande : « Essayer gratuitement » ou « Demander ma démo ». Sert à mesurer quelle porte d'entrée amène
// les fermes (voir Easystart/03-essai-gratuit.md). Absent (ancienne page en cache) = démonstration.
const SOURCES_VALIDES = ['essai', 'demo'];
// Mêmes valeurs que le formulaire de web/decouvrir.html (puces de secteur et liste de villes).
const SECTEURS_VALIDES = ['avicole', 'piscicole', 'maraicher', 'elevage'];
const VILLES_VALIDES = ['Thiès', 'Mbour', 'Petite Côte', 'Kaolack', 'Saint-Louis', 'Rufisque', 'Bambilor', 'Sangalkam', 'Dakar', 'Autre'];

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
     * enregistrer dans demandes_contact (migration-38, listée dans Support plateforme) PUIS notifier
     * l'équipe par email (voir email.envoyerNotificationContact).
     */
    router.post('/', limiteurContact, async (req, res) => {
        const nom = String(req.body.nom || '').trim();
        const emailVisiteur = String(req.body.email || '').trim();
        const whatsapp = normaliserTelephone(String(req.body.whatsapp || ''));
        const preference = String(req.body.preference || '').trim();
        const source = String(req.body.source || 'demo').trim();
        // Secteur, ferme et ville aident à préparer la démonstration. Facultatifs côté serveur (une ancienne page en cache
        // ne les envoie pas — le formulaire actuel impose au moins un secteur) ; présents mais invalides = refusés.
        const secteursRecus = Array.isArray(req.body.secteurs) ? req.body.secteurs.map((s) => String(s).trim()) : [];
        const nomFerme = String(req.body.nomFerme || '').trim();
        const ville = String(req.body.ville || '').trim();

        if (!nom || nom.length > 100) {
            return res.status(400).json({ erreur: 'Nom et prénom requis.' });
        }
        if (!emailFormatValide(emailVisiteur) || emailFarfelue(emailVisiteur)) {
            return res.status(400).json({ erreur: 'Adresse email invalide. Utilisez une adresse où nous pouvons vraiment vous recontacter.' });
        }
        if (!whatsapp) {
            return res.status(400).json({ erreur: "Numéro WhatsApp invalide. Indiquez-le avec l'indicatif du pays, par exemple +221 77 000 00 00." });
        }
        // Facultative : le formulaire actuel ne la demande plus, mais un ancien client (page en cache) peut
        // encore l'envoyer. Absente = ignorée ; présente mais hors liste = toujours refusée.
        if (preference && !PREFERENCES_VALIDES.includes(preference)) {
            return res.status(400).json({ erreur: 'Préférence de contact invalide.' });
        }

        if (!SOURCES_VALIDES.includes(source)) {
            return res.status(400).json({ erreur: 'Type de demande invalide.' });
        }
        if (secteursRecus.some((s) => !SECTEURS_VALIDES.includes(s))) {
            return res.status(400).json({ erreur: 'Secteur invalide.' });
        }
        const secteurs = SECTEURS_VALIDES.filter((s) => secteursRecus.includes(s)); // sans doublon, dans l'ordre du formulaire
        if (nomFerme.length > 100) {
            return res.status(400).json({ erreur: 'Nom de ferme trop long (100 caractères maximum).' });
        }
        if (ville && !VILLES_VALIDES.includes(ville)) {
            return res.status(400).json({ erreur: 'Ville invalide.' });
        }

        // Enregistrement d'abord : la demande ne dépend plus de l'email (boîte mail pleine, Resend en panne...). Un échec
        // d'enregistrement n'empêche pas l'envoi de l'email, qui reste alors le seul filet.
        let enregistree = false;
        try {
            await pool.query(
                `INSERT INTO demandes_contact (nom, email, whatsapp, preference, secteurs, nom_ferme, ville, source)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [nom, emailVisiteur, whatsapp, preference || null, secteurs.join(',') || null, nomFerme || null, ville || null, source]
            );
            enregistree = true;
        } catch (err) {
            console.error("Échec de l'enregistrement de la demande de contact :", err);
        }

        const succes = { message: 'Demande envoyée. Nous vous recontactons rapidement.' };
        if (!email.estConfigure()) {
            if (enregistree) return res.status(201).json(succes);
            return res.status(503).json({ erreur: 'Service de contact indisponible pour le moment. Écrivez-nous directement sur WhatsApp.' });
        }

        try {
            await email.envoyerNotificationContact({ nom, email: emailVisiteur, whatsapp, preference, secteurs, nomFerme, ville, source });
            res.status(201).json(succes);
        } catch (err) {
            console.error(err);
            if (enregistree) return res.status(201).json(succes);
            res.status(502).json({ erreur: "Échec de l'envoi. Écrivez-nous directement sur WhatsApp." });
        }
    });

    return router;
};

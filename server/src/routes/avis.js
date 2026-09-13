const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { queryPreTenant } = require('../auth');
const email = require('../email');

// Public, pas de compte à ce stade — même raisonnement que contact.js. Un peu plus permissif
// (20/h) : un visiteur peut légitimement revenir corriger une faute avant de resoumettre.
const limiteurAvis = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de demandes. Réessayez plus tard.' },
});

// Même limite que /auth/verifier-email (auth.js) pour un lien à jeton cliqué depuis un email.
const limiteurApprobation = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

module.exports = function avisRoutes(pool) {
    const router = express.Router();

    /**
     * Avis publiés (section "Avis clients", massla.sn/decouvrir). Seuls les avis approuve=TRUE
     * sont renvoyés — la modération (routes/plateforme.js, superviseur) est le seul moyen de les
     * faire apparaître ici, jamais le visiteur lui-même.
     */
    router.get('/', async (req, res) => {
        try {
            const result = await queryPreTenant(
                pool,
                `SELECT id, nom, nom_ferme, note, commentaire, cree_le
                 FROM avis_publics WHERE approuve = TRUE ORDER BY cree_le DESC LIMIT 50`
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des avis.' });
        }
    });

    /**
     * Soumission publique d'un avis — jamais publié directement (approuve=FALSE forcé ici, toute
     * valeur envoyée par le client pour ce champ est ignorée) : attend une validation manuelle par
     * un superviseur (vue Support plateforme) OU un clic sur le lien d'approbation reçu par email
     * (voir GET /approuver ci-dessous).
     */
    router.post('/', limiteurAvis, async (req, res) => {
        const nom = String(req.body.nom || '').trim();
        const nomFerme = String(req.body.nomFerme || '').trim();
        const note = Number(req.body.note);
        const commentaire = String(req.body.commentaire || '').trim();

        if (!nom || nom.length > 100) {
            return res.status(400).json({ erreur: 'Nom requis.' });
        }
        if (nomFerme.length > 100) {
            return res.status(400).json({ erreur: 'Nom de ferme trop long.' });
        }
        if (!Number.isInteger(note) || note < 1 || note > 5) {
            return res.status(400).json({ erreur: 'Note invalide (1 à 5).' });
        }
        if (!commentaire || commentaire.length > 600) {
            return res.status(400).json({ erreur: 'Commentaire requis (600 caractères max).' });
        }

        // Jeton d'approbation en un clic — généré à la soumission plutôt qu'à l'envoi de l'email
        // pour que le lien existe dès l'insertion, même si l'envoi de la notification échoue
        // ensuite (l'avis reste modérable depuis la vue Support plateforme dans tous les cas).
        const token = crypto.randomBytes(32).toString('hex');

        try {
            await queryPreTenant(
                pool,
                `INSERT INTO avis_publics (nom, nom_ferme, note, commentaire, approuve, token_approbation_hash, token_approbation_expire_le)
                 VALUES ($1, $2, $3, $4, FALSE, $5, now() + interval '30 days')`,
                [nom, nomFerme || null, note, commentaire, hashToken(token)]
            );
            res.status(201).json({ message: 'Merci ! Votre avis sera publié après validation.' });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ erreur: "Erreur lors de l'enregistrement de votre avis." });
        }

        // Envoi APRÈS la réponse au visiteur (jamais bloquant pour lui) — échec non critique : l'avis
        // existe déjà et reste approuvable depuis la vue Support plateforme sans ce lien.
        try {
            await email.envoyerNotificationAvis({ nom, nomFerme: nomFerme || null, note, commentaire, token });
        } catch (err) {
            console.error("Échec de l'envoi de la notification d'avis :", err);
        }
    });

    /**
     * Approbation en un clic depuis l'email de notification — même pattern que
     * GET /auth/verifier-email (auth.js) : jeton en clair reçu, comparé à son hash, effacé après
     * usage (lien à usage unique, expire après 30 jours). Consommée par web/approuver-avis.html.
     */
    router.get('/approuver', limiteurApprobation, async (req, res) => {
        const token = String(req.query.token || '');
        if (!token) return res.status(400).json({ erreur: 'Lien invalide.' });

        try {
            const result = await queryPreTenant(
                pool,
                `SELECT id, approuve, token_approbation_expire_le FROM avis_publics WHERE token_approbation_hash = $1`,
                [hashToken(token)]
            );
            const row = result.rows[0];
            // Comparaison d'expiration faite en JS, pas en SQL — même contournement que
            // verifier-email (pg-mem, utilisé en test, ne sait pas comparer TIMESTAMP à now()).
            if (!row || !row.token_approbation_expire_le || new Date(row.token_approbation_expire_le) <= new Date()) {
                return res.status(400).json({ erreur: 'Lien invalide ou expiré.' });
            }
            if (row.approuve) {
                return res.json({ message: 'Cet avis est déjà publié.' });
            }

            await queryPreTenant(
                pool,
                `UPDATE avis_publics SET approuve = TRUE, token_approbation_hash = NULL, token_approbation_expire_le = NULL WHERE id = $1`,
                [row.id]
            );
            res.json({ message: 'Avis publié. Merci !' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'approbation de l'avis." });
        }
    });

    return router;
};

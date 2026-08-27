const express = require('express');
const rateLimit = require('express-rate-limit');
const { creerNouvelleFerme } = require('../creerFerme');

if (!process.env.SIGNUP_INVITE_CODE && process.env.DATABASE_URL) {
    throw new Error(
        'SIGNUP_INVITE_CODE doit être défini explicitement dès qu\'une vraie base de données (DATABASE_URL) est configurée.'
    );
}
if (!process.env.SIGNUP_INVITE_CODE) {
    console.warn('⚠️  SIGNUP_INVITE_CODE non défini : code de démonstration utilisé (pg-mem uniquement, jamais en production).');
}
const SIGNUP_INVITE_CODE = process.env.SIGNUP_INVITE_CODE || 'demo-inscription-ferme-massla';

// Volontairement strict : la création de compte est plus rare et plus sensible qu'un simple essai
// de connexion — pas besoin de laisser une marge pour les fautes de frappe répétées d'un usage normal.
const limiteurInscription = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives d\'inscription. Réessayez plus tard.' },
});

module.exports = function inscriptionRoutes(pool) {
    const router = express.Router();

    /**
     * Crée une nouvelle organisation (ferme cliente) en self-service : plus besoin d'intervention
     * SQL manuelle (voir 2-Guide-configuration-nouveau-client.docx, qui reste la procédure de secours
     * si cette route est indisponible). Protégée par un code d'invitation transmis par Alioune après
     * la vente — pas une inscription publique ouverte à n'importe qui. Alternative réservée au
     * superviseur, sans code : POST /api/plateforme/organisations (routes/plateforme.js).
     */
    router.post('/', limiteurInscription, async (req, res) => {
        const { code, nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword } = req.body;

        if (code !== SIGNUP_INVITE_CODE) {
            return res.status(403).json({ erreur: "Code d'invitation invalide." });
        }

        try {
            // Durcissement sécurité (migration-20) : plus de connexion automatique ici — l'admin
            // créé par cette route est email_verifie=FALSE (creerFerme.js), donc une connexion
            // immédiate contournerait trivialement la vérification d'email bloquante pour le tout
            // premier compte de chaque nouvelle organisation, précisément le chemin le plus exposé
            // (données arbitraires côté appelant, aucune invitation d'un admin déjà de confiance).
            await creerNouvelleFerme(pool, { nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword });
            res.status(201).json({ message: 'Compte créé. Vérifiez votre boîte mail avant de vous connecter.' });
        } catch (err) {
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            if (err.code === '23505') {
                // Deux contraintes uniques possibles ici : utilisateurs.email (le cas courant) ou,
                // beaucoup plus rarement, organisations.slug en cas de course entre deux créations
                // du même nom de ferme au même instant (genererSlugUnique vérifie avant l'insertion,
                // mais ne verrouille rien entre-temps) — la base tranche en dernier ressort dans les
                // deux cas.
                if (err.constraint === 'organisations_slug_key') {
                    return res.status(409).json({ erreur: 'Ce nom de ferme est déjà utilisé, réessayez.' });
                }
                return res.status(409).json({ erreur: 'Cette adresse email est déjà utilisée.' });
            }
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de la ferme." });
        }
    });

    return router;
};

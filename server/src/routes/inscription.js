const express = require('express');
const rateLimit = require('express-rate-limit');
const { signToken } = require('../auth');
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
            const { admin, nomFerme: nomFermeCree } = await creerNouvelleFerme(pool, { nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword });
            const token = signToken({ ...admin, role_nom: 'admin' });
            res.status(201).json({
                token,
                utilisateur: {
                    id: admin.id,
                    nom_complet: admin.nom_complet,
                    email: admin.email,
                    role: 'admin',
                    secteur_id: admin.secteur_id,
                    tenant_id: admin.tenant_id,
                    organisation_nom: nomFermeCree,
                },
            });
        } catch (err) {
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            if (err.code === '23505') {
                // contrainte unique violée (utilisateurs.email) — jamais tenant_id, qui n'a pas de
                // contrainte unique propre.
                return res.status(409).json({ erreur: 'Cette adresse email est déjà utilisée.' });
            }
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de la ferme." });
        }
    });

    return router;
};

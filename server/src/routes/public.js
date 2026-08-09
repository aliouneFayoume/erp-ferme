const express = require('express');

// Domaine racine de la plateforme — massla.sn et www.massla.sn continuent de servir la marque
// Massla par défaut (comportement historique inchangé), seul un VRAI sous-domaine de ferme
// (<slug>.massla.sn) déclenche une résolution.
const DOMAINE_BASE = process.env.DOMAINE_BASE || 'massla.sn';

/**
 * Extrait le slug d'un hostname, ou null si ce n'est pas un sous-domaine de ferme reconnu
 * (domaine racine, www, localhost, IP directe, sous-domaine à plusieurs niveaux...).
 */
function extraireSlug(hostname) {
    if (!hostname) return null;
    if (hostname === DOMAINE_BASE || hostname === `www.${DOMAINE_BASE}`) return null;
    const suffixe = `.${DOMAINE_BASE}`;
    if (!hostname.endsWith(suffixe)) return null;
    const slug = hostname.slice(0, -suffixe.length);
    if (!slug || slug.includes('.')) return null;
    return slug;
}

/**
 * Routes publiques, sans authentification — uniquement des données non sensibles nécessaires
 * AVANT connexion (image de marque de l'écran de login/portail selon le sous-domaine visité).
 * Ne jamais y ajouter autre chose que ça sans reconsidérer pourquoi ce n'est pas derrière
 * requireAuth.
 */
module.exports = function publicRoutes(pool) {
    const router = express.Router();

    router.get('/organisation', async (req, res) => {
        const slug = extraireSlug(req.hostname);
        if (!slug) return res.json({ nom: null });
        try {
            const result = await pool.query(
                `SELECT nom FROM organisations WHERE slug = $1 AND deleted_at IS NULL`,
                [slug]
            );
            res.json({ nom: result.rows[0]?.nom || null });
        } catch (err) {
            console.error(err);
            // Non-critique (image de marque seulement) : on retombe sur la marque par défaut côté
            // frontend plutôt que de casser l'écran de connexion pour ça.
            res.json({ nom: null });
        }
    });

    return router;
};

module.exports.extraireSlug = extraireSlug;

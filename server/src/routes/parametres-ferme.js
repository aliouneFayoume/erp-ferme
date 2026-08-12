const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

/**
 * Réglages self-service du dépôt GPS (optimisation de tournée, routing.js) et des informations
 * affichées sur l'en-tête de la facture PDF (adresse, téléphone — facturePdf.js). Avant ceci, ces
 * deux points étaient codés en dur sur Ferme Massla pour toutes les fermes — audit systèmes
 * 2026-08-11, item #13. Nullable partout : une ferme qui ne renseigne rien ici garde le
 * comportement précédent (dépôt par défaut de routing.js, en-tête sans adresse/téléphone).
 */
module.exports = function parametresFermeRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const result = await req.db.query(
            `SELECT nom, adresse, telephone, gps_lat, gps_lng FROM organisations WHERE id = $1`,
            [req.user.tenant_id]
        );
        res.json(result.rows[0] || {});
    });

    router.put('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { adresse, telephone, gps_lat, gps_lng } = req.body;

        let lat = null;
        let lng = null;
        if (gps_lat !== '' && gps_lat != null) {
            lat = Number(gps_lat);
            if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
                return res.status(400).json({ erreur: 'Latitude invalide (doit être comprise entre -90 et 90).' });
            }
        }
        if (gps_lng !== '' && gps_lng != null) {
            lng = Number(gps_lng);
            if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
                return res.status(400).json({ erreur: 'Longitude invalide (doit être comprise entre -180 et 180).' });
            }
        }
        // Les deux coordonnées ou aucune : un dépôt à moitié renseigné (ex: lat sans lng) ne peut
        // pas être utilisé par optimiserTournee, autant l'empêcher ici plutôt que de le découvrir
        // au premier calcul de tournée.
        if ((lat === null) !== (lng === null)) {
            return res.status(400).json({ erreur: 'Renseignez la latitude ET la longitude, ou aucune des deux.' });
        }

        const result = await req.db.query(
            `UPDATE organisations SET adresse = $1, telephone = $2, gps_lat = $3, gps_lng = $4
             WHERE id = $5 RETURNING nom, adresse, telephone, gps_lat, gps_lng`,
            [adresse || null, telephone || null, lat, lng, req.user.tenant_id]
        );
        await logAudit(req.db, {
            table: 'organisations',
            rowId: req.user.tenant_id,
            action: 'UPDATE',
            userId: req.user.id,
            tenantId: req.user.tenant_id,
            details: { adresse, telephone, gps_lat: lat, gps_lng: lng },
        });
        res.json(result.rows[0]);
    });

    return router;
};

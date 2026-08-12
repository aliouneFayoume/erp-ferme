const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');
const { getWhatsappConfig, setWhatsappConfig } = require('../whatsappConfig');

/**
 * Réglages self-service des identifiants WhatsApp Business Cloud API : chaque organisation (hors
 * Ferme Massla elle-même, qui utilise les identifiants globaux — voir routes/finance.js) doit
 * configurer son propre compte pour relancer SES clients par WhatsApp. Même modèle que
 * routes/parametres-paiement.js (PayDunya) : réservé aux admins, identifiants jamais renvoyés en
 * clair une fois enregistrés.
 */
module.exports = function parametresWhatsappRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const orgRes = await req.db.query(`SELECT est_plateforme FROM organisations WHERE id = $1`, [req.user.tenant_id]);
        // Massla utilise ses identifiants globaux (server/.env, voir routes/finance.js) — ce réglage
        // self-service ne s'applique jamais à elle, même si un admin Massla remplissait ce formulaire
        // par erreur, la config créée resterait silencieusement inutilisée. On l'indique clairement
        // plutôt que de laisser l'admin croire que ça change quelque chose.
        if (orgRes.rows[0]?.est_plateforme) {
            return res.json({ estPlateforme: true, configure: true });
        }
        const config = await getWhatsappConfig(req.db, req.user.tenant_id);
        res.json({ estPlateforme: false, configure: !!config, templateNom: config?.templateNom || null, templateLangue: config?.templateLangue || null });
    });

    router.put('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { access_token, phone_number_id, template_nom, template_langue } = req.body;
        if (!access_token || !phone_number_id) {
            return res.status(400).json({ erreur: "Le jeton d'accès et l'ID du numéro de téléphone sont requis." });
        }
        try {
            await setWhatsappConfig(
                req.db,
                req.user.tenant_id,
                { accessToken: access_token, phoneNumberId: phone_number_id, templateNom: template_nom, templateLangue: template_langue },
                req.user.id
            );
            await logAudit(req.db, { req,
                table: 'organisation_whatsapp_config',
                rowId: req.user.tenant_id,
                action: 'UPDATE',
                userId: req.user.id,
                tenantId: req.user.tenant_id,
                details: {}, // jamais les identifiants eux-mêmes dans le journal d'audit
            });
            res.json({ configure: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement des identifiants WhatsApp." });
        }
    });

    return router;
};

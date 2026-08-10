const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');
const { getPaydunyaConfig, setPaydunyaConfig } = require('../paymentConfig');

/**
 * Réglages self-service de l'agrégateur de paiement PayDunya : chaque organisation est son propre
 * agrégateur (ses propres identifiants, son propre compte marchand) — Massla n'est qu'une
 * organisation comme une autre de ce point de vue. Réservé aux admins de l'organisation : ce sont
 * des identifiants de paiement, pas un réglage anodin.
 *
 * CORRIGÉ le 2026-08-10 : les deux routes appelaient getPaydunyaConfig/setPaydunyaConfig avec le
 * `pool` brut au lieu de `req.db` — organisation_paydunya_config est une table STRICTE (voir
 * rls-policies.sql), donc toute requête sur une connexion sans contexte tenant renvoie
 * silencieusement zéro ligne (lecture) ou échoue le WITH CHECK (écriture). Concrètement : cette
 * page a TOUJOURS affiché "non configuré" et n'a JAMAIS pu enregistrer quoi que ce soit depuis le
 * passage en RLS réel, pour AUCUNE organisation (y compris Massla), sans jamais lever d'erreur
 * visible. Vérifié directement en base de prod avant/après ce correctif (0 ligne sans contexte, 1
 * ligne avec). **pg-mem ne peut pas détecter cette classe de bug** (n'enforce jamais RLS) — les
 * tests existants passaient déjà avant ET après ce correctif, ne pas s'y fier pour ce genre de
 * régression, voir [[erp_ferme_pgmem_limitations]]/verify-rls.js.
 */
module.exports = function parametresPaiementRoutes(pool) {
    const router = express.Router();

    // Ne renvoie jamais les clés en clair une fois enregistrées (même logique que le PIN portail
    // client) : seul un statut "configuré / non configuré" est exposé, pour affichage.
    router.get('/paiement', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const config = await getPaydunyaConfig(req.db, req.user.tenant_id);
        if (!config) return res.json({ configure: false, mode: null });
        res.json({ configure: true, mode: config.mode });
    });

    router.put('/paiement', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { mode, master_key, private_key, public_key, token } = req.body;
        if (!['test', 'live'].includes(mode)) {
            return res.status(400).json({ erreur: 'Mode invalide (test ou live).' });
        }
        if (!master_key || !private_key || !public_key || !token) {
            return res.status(400).json({ erreur: 'Les 4 identifiants PayDunya sont requis.' });
        }
        try {
            await setPaydunyaConfig(
                req.db,
                req.user.tenant_id,
                { mode, masterKey: master_key, privateKey: private_key, publicKey: public_key, token },
                req.user.id
            );
            await logAudit(req.db, {
                table: 'organisation_paydunya_config',
                rowId: req.user.tenant_id,
                action: 'UPDATE',
                userId: req.user.id,
                tenantId: req.user.tenant_id,
                details: { mode }, // jamais les clés elles-mêmes dans le journal d'audit
            });
            res.json({ configure: true, mode });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement des identifiants de paiement." });
        }
    });

    return router;
};

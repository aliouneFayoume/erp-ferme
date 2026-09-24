const express = require('express');
const rateLimit = require('express-rate-limit');
const { lireJeton, avecContexteEmetteur, trouverTenantEmetteur, chargerFactureSaas, obtenirOuCreerCheckout } = require('../paiementsSaas');

/**
 * Lien de paiement STABLE d'une facture d'abonnement Massla (GET /api/payer/<jeton>) — page publique, sans
 * connexion : c'est ce lien que le superviseur envoie à la ferme (WhatsApp) ou qui figure dans l'email de rappel.
 * À chaque ouverture il fabrique un checkout PayDunya tout frais (repris s'il a moins de 10 minutes) puis
 * redirige vers la page de paiement hébergée par PayDunya. Un checkout PayDunya expire ~30 minutes après sa
 * création : ce détour évite d'envoyer une adresse déjà morte. Voir paiementsSaas.js.
 *
 * Aucun montant ni aucune information sur la ferme n'est lu depuis l'adresse : seul l'identifiant de facture,
 * signé (HMAC), est accepté — un jeton falsifié ou modifié est refusé sans toucher à la base ni à PayDunya.
 */

// Chaque ouverture peut créer un checkout chez PayDunya : plafond par IP contre les ouvertures en boucle.
const limiteurPayer = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => page(res, 429, 'Trop de tentatives', 'Veuillez patienter quelques minutes avant de rouvrir ce lien.'),
});

// Page de message autonome (aucun script, style en ligne : permis par la CSP de l'application), même esprit que
// web/paiement-abonnement-succes.html. Le texte est toujours statique, jamais dérivé de la requête.
function page(res, statut, titre, message) {
    res.status(statut)
        .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' })
        .send(`<!doctype html>
<html lang="fr"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${titre} — Massla</title></head>
<body style="margin:0;background:#f5f5f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1a1a;">
<div style="max-width:420px;margin:12vh auto;background:#fff;border-radius:10px;padding:28px 26px;box-shadow:0 2px 14px rgba(0,0,0,.08);">
<h1 style="margin:0 0 6px;font-size:22px;">Massla</h1>
<p style="margin:0 0 14px;font-weight:600;">${titre}</p>
<p style="margin:0 0 14px;color:#555;line-height:1.5;">${message}</p>
<p style="margin:0;color:#555;line-height:1.5;">Une question ? <a href="mailto:admin@massla.sn">admin@massla.sn</a> ou WhatsApp +1 416 526 6293.</p>
</div></body></html>`);
}

module.exports = function payerRoutes(pool) {
    const router = express.Router();

    router.get('/:jeton', limiteurPayer, async (req, res) => {
        const factureId = lireJeton(req.params.jeton);
        if (!factureId) {
            return page(res, 404, 'Lien invalide', 'Ce lien de paiement n’est pas valide. Contactez-nous pour en recevoir un nouveau.');
        }

        try {
            const emetteurTenantId = await trouverTenantEmetteur(pool);
            if (!emetteurTenantId) {
                return page(res, 503, 'Paiement indisponible', 'Le paiement en ligne est momentanément indisponible. Contactez-nous pour régler autrement.');
            }

            const resultat = await avecContexteEmetteur(pool, emetteurTenantId, async (db) => {
                const facture = await chargerFactureSaas(db, factureId);
                if (!facture) return { etat: 'introuvable' };
                if (facture.statut === 'PAYEE') return { etat: 'payee' };
                if (facture.statut === 'ANNULEE') return { etat: 'annulee' };
                const checkout = await obtenirOuCreerCheckout(db, { facture, emetteurTenantId });
                return { etat: 'ok', url: checkout.url };
            });

            if (resultat.etat === 'introuvable') return page(res, 404, 'Facture introuvable', 'Cette facture n’existe plus. Contactez-nous pour en savoir plus.');
            if (resultat.etat === 'payee') return page(res, 200, 'Facture déjà réglée', 'Cette facture est déjà réglée. Merci !');
            if (resultat.etat === 'annulee') return page(res, 410, 'Facture annulée', 'Cette facture a été annulée : il n’y a rien à payer.');
            if (!/^https:\/\//.test(resultat.url)) {
                return page(res, 502, 'Paiement indisponible', 'Le paiement en ligne est momentanément indisponible. Réessayez dans quelques minutes.');
            }
            res.set('Cache-Control', 'no-store');
            return res.redirect(302, resultat.url);
        } catch (err) {
            if (err.statutHttp === 502) {
                return page(res, 502, 'Paiement indisponible', 'PayDunya ne répond pas pour le moment. Réessayez dans quelques minutes.');
            }
            if (err.statutHttp) {
                return page(res, 503, 'Paiement indisponible', 'Le paiement en ligne est momentanément indisponible. Contactez-nous pour régler autrement.');
            }
            console.error('Erreur sur le lien de paiement SaaS:', err);
            return page(res, 500, 'Erreur', 'Une erreur est survenue. Réessayez dans quelques minutes.');
        }
    });

    return router;
};

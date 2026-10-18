// Passage en Pro depuis l'application (Easystart) : deux chemins pour une ferme en essai (ou dont l'essai est terminé).
//   - POST /passer-pro   : paiement en ligne (PayDunya). Crée la facture du premier mois Pro et renvoie le lien de paiement
//                          stable de Massla (/api/payer/<jeton>). C'est l'IPN (paiementsSaas.traiterIpnSaas) qui active le Pro, jamais
//                          cette route : on n'active RIEN sur la foi d'un clic. Fermé tant que PASSAGE_PRO_EN_LIGNE_ACTIF n'est pas « true ».
//   - POST /demande-pro  : « Parler à un conseiller ». Enregistre la demande (liste « à rappeler » de Support plateforme) ; le message
//                          WhatsApp lui-même est ouvert par le navigateur de la personne.
// Réservées à l'administrateur de la ferme ; la ferme visée est TOUJOURS celle de la session, jamais une valeur envoyée.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');
const { passageProEnLigneActif, prixProMensuel } = require('../modulesSaas');
const { getPaydunyaConfig } = require('../paymentConfig');
const { avecContexteEmetteur, trouverTenantEmetteur, creerJeton, erreurHttp, STATUTS_PAYABLES, NOTE_PASSAGE_PRO } = require('../paiementsSaas');

const DELAI_PAIEMENT_JOURS = 15;

// Chaque appel peut créer une facture : plafond par adresse IP, très au-delà d'un usage normal.
const limiteurPasserPro = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

function dansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

module.exports = function abonnementRoutes(pool) {
    const router = express.Router();
    const garde = [requireAuth(pool), checkRole(['admin'])];

    router.post('/passer-pro', limiteurPasserPro, ...garde, async (req, res) => {
        if (!passageProEnLigneActif()) {
            return res.status(503).json({ erreur: "Le paiement en ligne n'est pas encore ouvert. Utilisez « Parler à un conseiller ».", code: 'PASSAGE_PRO_INDISPONIBLE' });
        }
        // Seule une ferme en essai (ou essai terminé) passe en Pro ici : une ferme déjà Pro, ou « sur mesure », n'a rien à acheter.
        if (req.offre !== 'ESSAI' && req.offre !== 'EXPIRE') {
            return res.status(409).json({ erreur: req.offre === 'PRO' ? 'Votre ferme est déjà en Pro.' : "Votre ferme a un abonnement sur mesure : contactez le support pour le modifier." });
        }
        const tenantId = req.user.tenant_id;
        const montant = prixProMensuel();

        try {
            const emetteur = await trouverTenantEmetteur(pool);
            if (!emetteur) throw erreurHttp(503, 'Paiement indisponible pour le moment. Utilisez « Parler à un conseiller ».');

            const periode = new Date().toISOString().slice(0, 7);
            const facture = await avecContexteEmetteur(pool, emetteur, async (db) => {
                const credentials = await getPaydunyaConfig(db, emetteur);
                if (!credentials) throw erreurHttp(503, 'Paiement indisponible pour le moment. Utilisez « Parler à un conseiller ».');

                const existantes = await db.query(
                    `SELECT id, statut FROM factures_saas WHERE tenant_id = $1 AND type = 'ABONNEMENT' AND notes = $2 ORDER BY id DESC`,
                    [tenantId, NOTE_PASSAGE_PRO]
                );
                // Déjà payée mais le Pro n'est pas encore actif : la confirmation de PayDunya est en route, ne pas faire payer deux fois.
                if (existantes.rows.some((f) => f.statut === 'PAYEE')) {
                    throw erreurHttp(409, 'Votre paiement a bien été reçu et est en cours de traitement. Rechargez la page dans quelques instants.');
                }
                const aPayer = existantes.rows.find((f) => STATUTS_PAYABLES.includes(f.statut));
                if (aPayer) return { id: aPayer.id, reutilisee: true };

                const cree = await db.query(
                    `INSERT INTO factures_saas (tenant_id, type, periode, montant, date_echeance, notes) VALUES ($1, 'ABONNEMENT', $2, $3, $4, $5) RETURNING id`,
                    [tenantId, periode, montant, dansNJours(DELAI_PAIEMENT_JOURS), NOTE_PASSAGE_PRO]
                );
                await logAudit(db, { req, table: 'factures_saas', rowId: cree.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: { passage_pro: true, montant } });
                return { id: cree.rows[0].id, reutilisee: false };
            });

            const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
            res.json({ url: `${base}/api/payer/${creerJeton(facture.id)}`, montant });
        } catch (err) {
            if (err.statutHttp) return res.status(err.statutHttp).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la préparation du paiement.' });
        }
    });

    router.post('/demande-pro', ...garde, async (req, res) => {
        if (req.offre !== 'ESSAI' && req.offre !== 'EXPIRE') {
            return res.status(409).json({ erreur: 'Votre ferme est déjà en Pro ou sur mesure.' });
        }
        try {
            const tenantId = req.user.tenant_id;
            // Une seule demande à rappeler par ferme : des clics répétés ne doivent pas remplir la liste.
            const deja = await req.db.query(
                `SELECT id FROM demandes_contact WHERE tenant_id = $1 AND source = 'pro' AND traitee = FALSE LIMIT 1`,
                [tenantId]
            );
            if (deja.rows.length > 0) return res.json({ message: 'Votre demande est déjà enregistrée : nous vous rappelons.', dejaEnregistree: true });

            const u = await req.db.query(`SELECT email, telephone FROM utilisateurs WHERE id = $1`, [req.user.id]);
            const o = await req.db.query(`SELECT nom FROM organisations WHERE id = $1`, [tenantId]);
            const ligne = u.rows[0] || {};
            await req.db.query(
                `INSERT INTO demandes_contact (nom, email, whatsapp, nom_ferme, source, tenant_id) VALUES ($1, $2, $3, $4, 'pro', $5)`,
                [String(req.user.nom || 'Compte Massla').slice(0, 100), ligne.email || null, ligne.telephone || null, (o.rows[0] && o.rows[0].nom) || null, tenantId]
            );
            res.status(201).json({ message: 'Demande enregistrée : nous vous rappelons.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de la demande." });
        }
    });

    return router;
};

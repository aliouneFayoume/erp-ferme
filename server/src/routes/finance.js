const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');
const { genererFacturePDF } = require('../facturePdf');
const { creerFacture, confirmerFacture } = require('../paydunya');

module.exports = function financeRoutes(pool) {
    const router = express.Router();

    router.get('/factures', requireAuth, checkRole(['comptable']), async (req, res) => {
        // Bascule automatique en retard : pas de tâche planifiée dédiée, le statut est simplement
        // remis à jour à chaque consultation de l'écran (même logique "à la demande" que la
        // génération des commandes d'abonnement ailleurs dans ce projet).
        // Date du jour calculée en JS plutôt que CURRENT_DATE : pg-mem (simulation) renvoie un
        // horodatage complet pour CURRENT_DATE plutôt qu'une date tronquée, ce qui ferait basculer
        // une facture en retard dès le jour même de son échéance au lieu du lendemain.
        const aujourdhui = new Date().toISOString().slice(0, 10);
        await pool.query(
            `UPDATE factures SET statut = 'EN_RETARD' WHERE statut = 'A_PAYER' AND date_echeance < $1 AND montant_restant > 0`,
            [aujourdhui]
        );
        const result = await pool.query(
            `SELECT f.*, c.numero_commande, cl.nom as client_nom, cl.type_client
             FROM factures f
             JOIN commandes c ON f.commande_id = c.id
             JOIN clients cl ON c.client_id = cl.id
             ORDER BY f.date_echeance ASC LIMIT 200`
        );
        res.json(result.rows);
    });

    /** Génère et télécharge la facture PDF correspondante (client, lignes, montants, échéance). */
    router.get('/factures/:id/pdf', requireAuth, checkRole(['comptable']), async (req, res) => {
        const factureRes = await pool.query(
            `SELECT f.*, c.numero_commande, c.montant_total, c.client_id
             FROM factures f JOIN commandes c ON f.commande_id = c.id
             WHERE f.id = $1`,
            [req.params.id]
        );
        if (factureRes.rows.length === 0) return res.status(404).json({ erreur: 'Facture introuvable.' });
        const facture = factureRes.rows[0];

        const clientRes = await pool.query(`SELECT * FROM clients WHERE id = $1`, [facture.client_id]);
        const lignesRes = await pool.query(
            `SELECT lc.*, p.nom as produit_nom FROM lignes_commande lc JOIN produits p ON lc.produit_id = p.id WHERE lc.commande_id = $1`,
            [facture.commande_id]
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="facture-${facture.numero_commande}.pdf"`);
        genererFacturePDF(res, {
            facture,
            commande: { numero_commande: facture.numero_commande, montant_total: facture.montant_total },
            client: clientRes.rows[0],
            lignes: lignesRes.rows,
        });
    });

    router.get('/paiements', requireAuth, checkRole(['comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT p.*, cl.nom as client_nom FROM paiements p JOIN clients cl ON p.client_id = cl.id ORDER BY p.date_paiement DESC LIMIT 200`
        );
        res.json(result.rows);
    });

    /**
     * Initie un paiement Mobile Money (Wave/Orange Money) ou carte via PayDunya : crée une
     * facture PayDunya réelle et renvoie l'URL de paiement hébergée vers laquelle le frontend doit
     * rediriger le client. Le paiement reste EN_ATTENTE tant que l'IPN de confirmation n'est pas
     * arrivé (voir /paiements/ipn).
     */
    router.post('/paiements/initier', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { commande_id, client_id, montant, provider } = req.body;

        const commandeRes = await pool.query(`SELECT numero_commande FROM commandes WHERE id = $1`, [commande_id]);
        if (commandeRes.rows.length === 0) return res.status(404).json({ erreur: 'Commande introuvable.' });

        let facture;
        try {
            facture = await creerFacture({
                montant,
                description: `Commande ${commandeRes.rows[0].numero_commande} — Ferme Massla`,
                referenceInterne: `${commande_id}-${Date.now()}`,
            });
        } catch (err) {
            console.error('Échec de création de facture PayDunya:', err.message);
            return res.status(502).json({ erreur: 'Impossible de contacter PayDunya pour initier le paiement.' });
        }

        const result = await pool.query(
            `INSERT INTO paiements (commande_id, client_id, montant, methode_paiement, reference_transaction, statut)
             VALUES ($1, $2, $3, $4, $5, 'EN_ATTENTE') RETURNING *`,
            [commande_id, client_id, montant, provider || 'WAVE', facture.token]
        );
        await logAudit(pool, { table: 'paiements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: { commande_id, montant, provider } });
        res.status(201).json({ ...result.rows[0], checkout_url: facture.url });
    });

    /**
     * IPN (Instant Payment Notification) appelée par PayDunya après une tentative de paiement.
     * Pas de checkRole : appelée par un serveur externe. Sécurité : on ne fait JAMAIS confiance au
     * contenu de cette requête pour créditer quoi que ce soit — on relit le token puis on interroge
     * l'API PayDunya nous-mêmes (avec nos propres clés) pour connaître le statut réel de la facture.
     */
    router.post('/paiements/ipn', async (req, res) => {
        const body = req.body || {};
        let token;
        try {
            // PayDunya envoie du x-www-form-urlencoded avec un champ "data" (JSON stringifié) ;
            // on gère aussi un corps JSON direct par prudence face aux variations d'intégration.
            const data = typeof body.data === 'string' ? JSON.parse(body.data) : body.data || body;
            token = data?.invoice?.token || data?.token;
        } catch (e) {
            token = undefined;
        }
        if (!token) return res.status(400).json({ erreur: 'Token de facture manquant dans la notification.' });

        let confirmation;
        try {
            confirmation = await confirmerFacture(token);
        } catch (err) {
            console.error('Échec de confirmation PayDunya (IPN):', err.message);
            return res.status(502).json({ erreur: 'Impossible de vérifier le paiement auprès de PayDunya.' });
        }

        if (confirmation.status !== 'completed') {
            // 200 volontaire : notification bien reçue et traitée (rien à créditer pour un statut
            // pending/cancelled), pour éviter que PayDunya ne la retente indéfiniment.
            return res.status(200).json({ message: `Statut ${confirmation.status} — aucune écriture.` });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // FOR UPDATE : verrouille la ligne le temps de la transaction pour qu'une IPN dupliquée
            // (retry légitime de PayDunya) ne puisse pas valider et créditer deux fois le même paiement.
            const paiementRes = await client.query(
                `SELECT id, commande_id, client_id FROM paiements WHERE reference_transaction = $1 AND statut = 'EN_ATTENTE' FOR UPDATE`,
                [token]
            );
            if (paiementRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(200).json({ message: 'Paiement introuvable ou déjà traité (idempotence).' });
            }
            const paiement = paiementRes.rows[0];

            await client.query(
                `UPDATE paiements SET statut = 'VALIDE', date_paiement = CURRENT_TIMESTAMP WHERE id = $1`,
                [paiement.id]
            );

            // Note : pg-mem (simulation) inverse le signe de "colonne - $param" ; on ajoute une valeur
            // négative pour rester compatible avec pg-mem ET PostgreSQL réel.
            const moinsMontant = -Number(confirmation.montant);
            await client.query(
                `UPDATE factures SET montant_restant = GREATEST(montant_restant + $1, 0),
                     statut = CASE WHEN montant_restant + $1 <= 0 THEN 'PAYEE' ELSE 'PAYEE_PARTIEL' END
                 WHERE commande_id = $2`,
                [moinsMontant, paiement.commande_id]
            );

            const clientRow = await client.query(`SELECT type_client FROM clients WHERE id = $1`, [paiement.client_id]);
            if (clientRow.rows[0]?.type_client === 'B2B') {
                await client.query(`UPDATE clients SET solde_encours = GREATEST(solde_encours + $1, 0) WHERE id = $2`, [moinsMontant, paiement.client_id]);
            }

            await client.query('COMMIT');
            await logAudit(pool, {
                table: 'paiements',
                rowId: paiement.id,
                action: 'UPDATE',
                details: { token, montant: confirmation.montant, provider_reference: confirmation.providerReference },
            });
            res.status(200).json({ message: 'Paiement PayDunya confirmé, caisse mise à jour.' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Erreur de traitement IPN PayDunya:', err.message);
            res.status(500).json({ erreur: 'Erreur interne lors du traitement du paiement.' });
        } finally {
            client.release();
        }
    });

    return router;
};

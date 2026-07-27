const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function financeRoutes(pool) {
    const router = express.Router();

    router.get('/factures', requireAuth, checkRole(['comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT f.*, c.numero_commande, cl.nom as client_nom, cl.type_client
             FROM factures f
             JOIN commandes c ON f.commande_id = c.id
             JOIN clients cl ON c.client_id = cl.id
             WHERE f.tenant_id = $1
             ORDER BY f.date_echeance ASC LIMIT 200`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.get('/paiements', requireAuth, checkRole(['comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT p.*, cl.nom as client_nom FROM paiements p JOIN clients cl ON p.client_id = cl.id WHERE p.tenant_id = $1 ORDER BY p.date_paiement DESC LIMIT 200`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    /**
     * Initie un paiement Mobile Money en attente (simule l'appel Push USSD Wave/Orange Money).
     * Le webhook ci-dessous simule la confirmation asynchrone du provider. La référence inclut le
     * tenant_id (prototype multi-tenant) pour garantir son unicité entre organisations : le webhook,
     * appelé sans contexte utilisateur, retrouve ainsi le bon paiement et son organisation rien qu'à
     * partir de cette référence.
     */
    router.post('/paiements/initier', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { commande_id, client_id, montant, provider } = req.body;
        const reference = `${provider || 'WAVE'}-${req.user.tenant_id}-${Date.now()}`;
        const result = await pool.query(
            `INSERT INTO paiements (tenant_id, commande_id, client_id, montant, methode_paiement, reference_transaction, statut)
             VALUES ($1, $2, $3, $4, $5, $6, 'EN_ATTENTE') RETURNING *`,
            [req.user.tenant_id, commande_id, client_id, montant, provider || 'WAVE', reference]
        );
        await logAudit(pool, { table: 'paiements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { commande_id, montant, provider } });
        res.status(201).json(result.rows[0]);
    });

    /**
     * Webhook appelé par les API de Wave ou Orange Money lors d'un paiement réussi.
     * Pas de checkRole : appelée par un serveur externe (en production, vérifier la signature HMAC).
     */
    router.post('/paiements/webhook', async (req, res) => {
        const { reference_transaction, statut_paiement, montant, provider } = req.body;

        if (!reference_transaction || statut_paiement !== 'SUCCESS') {
            return res.status(400).json({ erreur: 'Données de webhook invalides ou paiement échoué.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // FOR UPDATE : verrouille la ligne le temps de la transaction pour qu'un webhook dupliqué
            // (retry légitime du provider) ne puisse pas valider et créditer deux fois le même paiement.
            const paiementRes = await client.query(
                `SELECT id, tenant_id, commande_id, client_id FROM paiements WHERE reference_transaction = $1 AND statut = 'EN_ATTENTE' FOR UPDATE`,
                [reference_transaction]
            );
            if (paiementRes.rows.length === 0) throw new Error('Paiement introuvable ou déjà traité.');
            const paiement = paiementRes.rows[0];

            await client.query(
                `UPDATE paiements SET statut = 'VALIDE', methode_paiement = COALESCE($1, methode_paiement), date_paiement = CURRENT_TIMESTAMP WHERE id = $2`,
                [provider, paiement.id]
            );

            // Note : pg-mem (simulation) inverse le signe de "colonne - $param" ; on ajoute une valeur
            // négative pour rester compatible avec pg-mem ET PostgreSQL réel.
            const moinsMontant = -Number(montant);
            await client.query(
                `UPDATE factures SET montant_restant = GREATEST(montant_restant + $1, 0),
                     statut = CASE WHEN montant_restant + $1 <= 0 THEN 'PAYEE' ELSE 'PAYEE_PARTIEL' END
                 WHERE commande_id = $2 AND tenant_id = $3`,
                [moinsMontant, paiement.commande_id, paiement.tenant_id]
            );

            const clientRow = await client.query(`SELECT type_client FROM clients WHERE id = $1 AND tenant_id = $2`, [paiement.client_id, paiement.tenant_id]);
            if (clientRow.rows[0]?.type_client === 'B2B') {
                await client.query(`UPDATE clients SET solde_encours = GREATEST(solde_encours + $1, 0) WHERE id = $2 AND tenant_id = $3`, [moinsMontant, paiement.client_id, paiement.tenant_id]);
            }

            await client.query('COMMIT');
            await logAudit(pool, { table: 'paiements', rowId: paiement.id, action: 'UPDATE', tenantId: paiement.tenant_id, details: { reference_transaction, montant } });
            res.status(200).json({ message: 'Webhook traité avec succès. Caisse mise à jour.' });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Erreur de traitement du webhook:', err.message);
            res.status(500).json({ erreur: 'Erreur interne lors du traitement du paiement.' });
        } finally {
            client.release();
        }
    });

    return router;
};

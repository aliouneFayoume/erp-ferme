const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function abonnementsRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT a.*, c.nom as client_nom, c.telephone, p.nom as produit_nom, p.prix_unitaire_b2c
             FROM abonnements a
             JOIN clients c ON a.client_id = c.id
             JOIN produits p ON a.produit_id = p.id
             WHERE a.deleted_at IS NULL
             ORDER BY a.actif DESC, a.jour_livraison`
        );
        res.json(result.rows);
    });

    router.post('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { client_id, produit_id, quantite, frequence, jour_livraison } = req.body;
        if (!client_id || !produit_id || !jour_livraison) {
            return res.status(400).json({ erreur: 'Client, produit et jour de livraison sont requis.' });
        }
        try {
            const result = await pool.query(
                `INSERT INTO abonnements (client_id, produit_id, quantite, frequence, jour_livraison, actif)
                 VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
                [client_id, produit_id, quantite || 1, frequence || 'HEBDOMADAIRE', jour_livraison]
            );
            await pool.query(`UPDATE clients SET est_abonne = TRUE WHERE id = $1`, [client_id]);
            await logAudit(pool, { table: 'abonnements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'abonnement." });
        }
    });

    router.put('/:id/statut', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { actif } = req.body;
        const result = await pool.query(`UPDATE abonnements SET actif = $1 WHERE id = $2 RETURNING *`, [!!actif, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Abonnement introuvable.' });
        await logAudit(pool, { table: 'abonnements', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { actif } });
        res.json(result.rows[0]);
    });

    router.delete('/:id', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        await pool.query(`UPDATE abonnements SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        await logAudit(pool, { table: 'abonnements', rowId: req.params.id, action: 'DELETE', userId: req.user.id });
        res.status(204).end();
    });

    /**
     * Génère les commandes B2C du jour pour tous les abonnements actifs dont le jour de livraison
     * correspond au jour de la semaine courant (paniers récurrents). Applique la même logique de
     * réservation de stock et de tarification que la création manuelle de commande.
     */
    router.post('/generer-commandes', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        // Le Sénégal (Dakar) est en GMT+0, comme UTC : on utilise getUTCDay() pour ne pas dépendre
        // du fuseau horaire local de la machine qui héberge le serveur.
        const JOURS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
        const jourDuJour = JOURS[new Date().getUTCDay()];

        const abonnements = await pool.query(
            `SELECT a.*, p.nom as produit_nom, p.prix_unitaire_b2c, s.quantite_disponible
             FROM abonnements a
             JOIN produits p ON a.produit_id = p.id
             JOIN stocks s ON s.produit_id = p.id
             WHERE a.actif = TRUE AND a.deleted_at IS NULL AND a.jour_livraison = $1`,
            [jourDuJour]
        );

        const resultats = { creees: 0, echecs: [] };

        for (const ab of abonnements.rows) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Verrouille la ligne d'abonnement : si deux déclenchements de génération se
                // chevauchent (bouton manuel + tâche planifiée par ex.), le second attend que le
                // premier valide avant de faire son propre contrôle anti-doublon ci-dessous.
                await client.query(`SELECT id FROM abonnements WHERE id = $1 FOR UPDATE`, [ab.id]);

                const dejaGeneree = await client.query(
                    `SELECT c.id FROM commandes c
                     JOIN lignes_commande lc ON lc.commande_id = c.id
                     WHERE c.client_id = $1 AND lc.produit_id = $2 AND c.cree_le >= $3`,
                    [ab.client_id, ab.produit_id, new Date().toISOString().slice(0, 10)]
                );
                if (dejaGeneree.rows.length > 0) {
                    await client.query('ROLLBACK');
                    continue;
                }

                const stockRes = await client.query(`SELECT quantite_disponible FROM stocks WHERE produit_id = $1 FOR UPDATE`, [ab.produit_id]);
                const disponible = Number(stockRes.rows[0]?.quantite_disponible || 0);
                if (disponible < ab.quantite) {
                    throw new Error(`Stock insuffisant pour ${ab.produit_nom}`);
                }

                const montant = Number(ab.prix_unitaire_b2c) * Number(ab.quantite);
                const numero = `ABO-${Date.now().toString().slice(-6)}-${ab.id}`;
                const commande = await client.query(
                    `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ($1, $2, 'EN_ATTENTE', $3) RETURNING id`,
                    [numero, ab.client_id, montant]
                );
                await client.query(
                    `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, $3, $4, $5)`,
                    [commande.rows[0].id, ab.produit_id, ab.quantite, ab.prix_unitaire_b2c, montant]
                );
                await client.query(
                    `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, quantite_reservee_b2c = quantite_reservee_b2c + $2 WHERE produit_id = $3`,
                    [-ab.quantite, ab.quantite, ab.produit_id]
                );
                await client.query(
                    `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', $3)`,
                    [commande.rows[0].id, new Date().toISOString().slice(0, 10), montant]
                );

                await client.query('COMMIT');
                resultats.creees += 1;
            } catch (err) {
                await client.query('ROLLBACK');
                resultats.echecs.push({ abonnement_id: ab.id, produit: ab.produit_nom, erreur: err.message });
            } finally {
                client.release();
            }
        }

        await logAudit(pool, { table: 'commandes', action: 'CREATE', userId: req.user.id, details: { source: 'abonnements', ...resultats } });
        res.json({ jour: jourDuJour, ...resultats });
    });

    return router;
};

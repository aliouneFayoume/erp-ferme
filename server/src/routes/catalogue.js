const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function catalogueRoutes(pool) {
    const router = express.Router();

    router.get('/produits', requireAuth, async (req, res) => {
        const result = await pool.query(
            `SELECT p.*, s.nom as secteur_nom,
                    st.quantite_disponible, st.quantite_reservee_b2b, st.quantite_reservee_b2c, st.seuil_alerte
             FROM produits p
             JOIN secteurs s ON p.secteur_id = s.id
             LEFT JOIN stocks st ON st.produit_id = p.id
             WHERE p.deleted_at IS NULL AND p.actif = TRUE
             ORDER BY s.nom, p.nom`
        );
        res.json(result.rows);
    });

    router.post('/produits', requireAuth, checkRole(['admin']), async (req, res) => {
        const { secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste, quantite_initiale, seuil_alerte } = req.body;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const produit = await client.query(
                `INSERT INTO produits (secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste || null]
            );
            await client.query(
                `INSERT INTO stocks (produit_id, quantite_disponible, seuil_alerte) VALUES ($1, $2, $3)`,
                [produit.rows[0].id, quantite_initiale || 0, seuil_alerte || 10]
            );
            await client.query('COMMIT');
            await logAudit(pool, { table: 'produits', rowId: produit.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(produit.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du produit.' });
        } finally {
            client.release();
        }
    });

    // Tarifs dynamiques : modification de la grille standard/restaurant/grossiste (Super-Admin uniquement)
    router.put('/produits/:id/tarifs', requireAuth, checkRole(['admin']), async (req, res) => {
        const { prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste } = req.body;
        try {
            const result = await pool.query(
                `UPDATE produits SET prix_unitaire_b2b = COALESCE($1, prix_unitaire_b2b),
                        prix_unitaire_b2c = COALESCE($2, prix_unitaire_b2c),
                        prix_unitaire_grossiste = COALESCE($3, prix_unitaire_grossiste)
                 WHERE id = $4 AND deleted_at IS NULL RETURNING *`,
                [prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Produit introuvable.' });
            await logAudit(pool, { table: 'produits', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour des tarifs.' });
        }
    });

    router.put('/produits/:id/stock', requireAuth, checkRole(['admin', 'chef_prod']), async (req, res) => {
        const { quantite_disponible, seuil_alerte } = req.body;
        try {
            const result = await pool.query(
                `UPDATE stocks SET quantite_disponible = COALESCE($1, quantite_disponible),
                        seuil_alerte = COALESCE($2, seuil_alerte), derniere_mise_a_jour = CURRENT_TIMESTAMP
                 WHERE produit_id = $3 RETURNING *`,
                [quantite_disponible, seuil_alerte, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Stock introuvable.' });
            await logAudit(pool, { table: 'stocks', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du stock.' });
        }
    });

    router.delete('/produits/:id', requireAuth, checkRole(['admin']), async (req, res) => {
        await pool.query(`UPDATE produits SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        await logAudit(pool, { table: 'produits', rowId: req.params.id, action: 'DELETE', userId: req.user.id });
        res.status(204).end();
    });

    return router;
};

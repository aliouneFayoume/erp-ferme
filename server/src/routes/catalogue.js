const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function catalogueRoutes(pool) {
    const router = express.Router();

    router.get('/produits', requireAuth(pool), async (req, res) => {
        const result = await req.db.query(
            `SELECT p.*, s.nom as secteur_nom,
                    st.quantite_disponible, st.quantite_reservee_b2b, st.quantite_reservee_b2c, st.seuil_alerte
             FROM produits p
             JOIN secteurs s ON p.secteur_id = s.id
             LEFT JOIN stocks st ON st.produit_id = p.id
             WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.actif = TRUE
             ORDER BY s.nom, p.nom`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/produits', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste, quantite_initiale, seuil_alerte } = req.body;
        const client = req.db;
        try {
            await client.query('BEGIN');
            const secteurRes = await client.query(`SELECT id FROM secteurs WHERE id = $1 AND tenant_id = $2`, [secteur_id, req.user.tenant_id]);
            if (secteurRes.rows.length === 0) throw { statut: 400, message: 'Secteur invalide.' };
            const produit = await client.query(
                `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [req.user.tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste || null]
            );
            await client.query(
                `INSERT INTO stocks (produit_id, quantite_disponible, seuil_alerte) VALUES ($1, $2, $3)`,
                [produit.rows[0].id, quantite_initiale || 0, seuil_alerte || 10]
            );
            await client.query('COMMIT');
            await logAudit(req.db, { req, table: 'produits', rowId: produit.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(produit.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du produit.' });
        }
    });

    // Tarifs dynamiques : modification de la grille standard/restaurant/grossiste (Super-Admin uniquement)
    router.put('/produits/:id/tarifs', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste } = req.body;
        try {
            const result = await req.db.query(
                `UPDATE produits SET prix_unitaire_b2b = COALESCE($1, prix_unitaire_b2b),
                        prix_unitaire_b2c = COALESCE($2, prix_unitaire_b2c),
                        prix_unitaire_grossiste = COALESCE($3, prix_unitaire_grossiste)
                 WHERE id = $4 AND tenant_id = $5 AND deleted_at IS NULL RETURNING *`,
                [prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Produit introuvable.' });
            await logAudit(req.db, { req, table: 'produits', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour des tarifs.' });
        }
    });

    router.put('/produits/:id/stock', requireAuth(pool), checkRole(['admin', 'chef_prod']), async (req, res) => {
        const { quantite_disponible, seuil_alerte } = req.body;
        try {
            const result = await req.db.query(
                `UPDATE stocks SET quantite_disponible = COALESCE($1, quantite_disponible),
                        seuil_alerte = COALESCE($2, seuil_alerte), derniere_mise_a_jour = CURRENT_TIMESTAMP
                 WHERE produit_id = $3 AND produit_id IN (SELECT id FROM produits WHERE tenant_id = $4) RETURNING *`,
                [quantite_disponible, seuil_alerte, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Stock introuvable.' });
            await logAudit(req.db, { req, table: 'stocks', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du stock.' });
        }
    });

    router.delete('/produits/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        await req.db.query(`UPDATE produits SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
        await logAudit(req.db, { req, table: 'produits', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    return router;
};

const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function comptabiliteRoutes(pool) {
    const router = express.Router();

    // -------------------- Dépenses par pôle --------------------

    router.get('/depenses', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT d.*, s.nom as secteur_nom FROM depenses d
             LEFT JOIN secteurs s ON d.secteur_id = s.id
             WHERE d.deleted_at IS NULL ORDER BY d.date_depense DESC LIMIT 200`
        );
        res.json(result.rows);
    });

    router.post('/depenses', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { secteur_id, categorie, montant, description, date_depense } = req.body;
        if (!categorie || !montant || !date_depense) {
            return res.status(400).json({ erreur: 'Catégorie, montant et date sont requis.' });
        }
        try {
            const result = await pool.query(
                `INSERT INTO depenses (secteur_id, categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [secteur_id || null, categorie, montant, description || null, date_depense, req.user.id]
            );
            await logAudit(pool, { table: 'depenses', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création de la dépense.' });
        }
    });

    router.delete('/depenses/:id', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        await pool.query(`UPDATE depenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        await logAudit(pool, { table: 'depenses', rowId: req.params.id, action: 'DELETE', userId: req.user.id });
        res.status(204).end();
    });

    // -------------------- Comptabilité analytique par pôle --------------------

    router.get('/analytique', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        try {
            const [secteurs, ca, dep] = await Promise.all([
                pool.query(`SELECT * FROM secteurs ORDER BY id`),
                pool.query(
                    `SELECT p.secteur_id, COALESCE(SUM(lc.sous_total), 0) as total
                     FROM lignes_commande lc
                     JOIN produits p ON lc.produit_id = p.id
                     JOIN commandes c ON lc.commande_id = c.id
                     WHERE c.statut != 'ANNULEE' AND c.deleted_at IS NULL
                     GROUP BY p.secteur_id`
                ),
                pool.query(
                    `SELECT secteur_id, COALESCE(SUM(montant), 0) as total FROM depenses
                     WHERE deleted_at IS NULL GROUP BY secteur_id`
                ),
            ]);

            const caParSecteur = Object.fromEntries(ca.rows.map((r) => [r.secteur_id, Number(r.total)]));
            const depParSecteur = Object.fromEntries(dep.rows.map((r) => [r.secteur_id, Number(r.total)]));

            const parPole = secteurs.rows.map((s) => {
                const chiffreAffaires = caParSecteur[s.id] || 0;
                const depenses = depParSecteur[s.id] || 0;
                return {
                    secteur_id: s.id,
                    secteur_nom: s.nom,
                    chiffreAffaires,
                    depenses,
                    marge: chiffreAffaires - depenses,
                };
            });

            const depensesGenerales = Number(dep.rows.find((r) => r.secteur_id === null)?.total || 0);

            res.json({ parPole, depensesGenerales });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors du calcul de la comptabilité analytique." });
        }
    });

    // -------------------- Rapprochement bancaire --------------------

    router.get('/releves-bancaires', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT rb.*, p.reference_transaction, p.methode_paiement, cl.nom as client_nom
             FROM releves_bancaires rb
             LEFT JOIN paiements p ON rb.paiement_id = p.id
             LEFT JOIN clients cl ON p.client_id = cl.id
             ORDER BY rb.date_operation DESC LIMIT 200`
        );
        res.json(result.rows);
    });

    router.post('/releves-bancaires', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { date_operation, libelle, montant, type_operation } = req.body;
        if (!date_operation || !libelle || !montant || !type_operation) {
            return res.status(400).json({ erreur: 'Date, libellé, montant et type sont requis.' });
        }
        try {
            const result = await pool.query(
                `INSERT INTO releves_bancaires (date_operation, libelle, montant, type_operation, cree_par)
                 VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                [date_operation, libelle, montant, type_operation, req.user.id]
            );
            await logAudit(pool, { table: 'releves_bancaires', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'ajout de l'opération bancaire." });
        }
    });

    router.put('/releves-bancaires/:id/rapprocher', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { paiement_id } = req.body;
        try {
            const result = await pool.query(
                `UPDATE releves_bancaires SET paiement_id = $1, rapproche = TRUE, rapproche_par = $2 WHERE id = $3 RETURNING *`,
                [paiement_id, req.user.id, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
            await logAudit(pool, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { paiement_id, rapproche: true } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du rapprochement.' });
        }
    });

    router.put('/releves-bancaires/:id/annuler-rapprochement', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `UPDATE releves_bancaires SET paiement_id = NULL, rapproche = FALSE, rapproche_par = NULL WHERE id = $1 RETURNING *`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
        await logAudit(pool, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { rapproche: false } });
        res.json(result.rows[0]);
    });

    return router;
};

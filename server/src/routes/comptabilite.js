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
             WHERE d.tenant_id = $1 AND d.deleted_at IS NULL ORDER BY d.date_depense DESC LIMIT 200`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/depenses', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { secteur_id, categorie, montant, description, date_depense } = req.body;
        if (!categorie || !montant || !date_depense) {
            return res.status(400).json({ erreur: 'Catégorie, montant et date sont requis.' });
        }
        try {
            if (secteur_id) {
                const secteurRes = await pool.query(`SELECT id FROM secteurs WHERE id = $1 AND tenant_id = $2`, [secteur_id, req.user.tenant_id]);
                if (secteurRes.rows.length === 0) return res.status(400).json({ erreur: 'Secteur invalide.' });
            }
            const result = await pool.query(
                `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [req.user.tenant_id, secteur_id || null, categorie, montant, description || null, date_depense, req.user.id]
            );
            await logAudit(pool, { table: 'depenses', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création de la dépense.' });
        }
    });

    router.delete('/depenses/:id', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        await pool.query(`UPDATE depenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
        await logAudit(pool, { table: 'depenses', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    // -------------------- Comptabilité analytique par pôle --------------------

    router.get('/analytique', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        try {
            const tenantId = req.user.tenant_id;
            const [secteurs, ca, dep] = await Promise.all([
                pool.query(`SELECT * FROM secteurs WHERE tenant_id = $1 ORDER BY id`, [tenantId]),
                pool.query(
                    `SELECT p.secteur_id, COALESCE(SUM(lc.sous_total), 0) as total
                     FROM lignes_commande lc
                     JOIN produits p ON lc.produit_id = p.id
                     JOIN commandes c ON lc.commande_id = c.id
                     WHERE c.tenant_id = $1 AND c.statut != 'ANNULEE' AND c.deleted_at IS NULL
                     GROUP BY p.secteur_id`,
                    [tenantId]
                ),
                pool.query(
                    `SELECT secteur_id, COALESCE(SUM(montant), 0) as total FROM depenses
                     WHERE tenant_id = $1 AND deleted_at IS NULL GROUP BY secteur_id`,
                    [tenantId]
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
             WHERE rb.tenant_id = $1
             ORDER BY rb.date_operation DESC LIMIT 200`,
            [req.user.tenant_id]
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
                `INSERT INTO releves_bancaires (tenant_id, date_operation, libelle, montant, type_operation, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [req.user.tenant_id, date_operation, libelle, montant, type_operation, req.user.id]
            );
            await logAudit(pool, { table: 'releves_bancaires', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'ajout de l'opération bancaire." });
        }
    });

    router.put('/releves-bancaires/:id/rapprocher', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { paiement_id } = req.body;
        try {
            if (paiement_id) {
                const paiementRes = await pool.query(`SELECT id FROM paiements WHERE id = $1 AND tenant_id = $2`, [paiement_id, req.user.tenant_id]);
                if (paiementRes.rows.length === 0) return res.status(400).json({ erreur: 'Paiement invalide.' });
            }
            const result = await pool.query(
                `UPDATE releves_bancaires SET paiement_id = $1, rapproche = TRUE, rapproche_par = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
                [paiement_id, req.user.id, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
            await logAudit(pool, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { paiement_id, rapproche: true } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du rapprochement.' });
        }
    });

    router.put('/releves-bancaires/:id/annuler-rapprochement', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `UPDATE releves_bancaires SET paiement_id = NULL, rapproche = FALSE, rapproche_par = NULL WHERE id = $1 AND tenant_id = $2 RETURNING *`,
            [req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
        await logAudit(pool, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { rapproche: false } });
        res.json(result.rows[0]);
    });

    return router;
};

const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function comptabiliteRoutes(pool) {
    const router = express.Router();

    // -------------------- Dépenses par pôle --------------------

    router.get('/depenses', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await req.db.query(
            `SELECT d.*, s.nom as secteur_nom FROM depenses d
             LEFT JOIN secteurs s ON d.secteur_id = s.id
             WHERE d.tenant_id = $1 AND d.deleted_at IS NULL ORDER BY d.date_depense DESC LIMIT 200`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/depenses', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { secteur_id, categorie, montant, description, date_depense } = req.body;
        if (!categorie || !montant || !date_depense) {
            return res.status(400).json({ erreur: 'Catégorie, montant et date sont requis.' });
        }
        try {
            if (secteur_id) {
                const secteurRes = await req.db.query(`SELECT id FROM secteurs WHERE id = $1 AND tenant_id = $2`, [secteur_id, req.user.tenant_id]);
                if (secteurRes.rows.length === 0) return res.status(400).json({ erreur: 'Secteur invalide.' });
            }
            const result = await req.db.query(
                `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [req.user.tenant_id, secteur_id || null, categorie, montant, description || null, date_depense, req.user.id]
            );
            await logAudit(req.db, { table: 'depenses', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création de la dépense.' });
        }
    });

    router.delete('/depenses/:id', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        await req.db.query(`UPDATE depenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
        await logAudit(req.db, { table: 'depenses', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    // -------------------- Comptabilité analytique par pôle --------------------

    router.get('/analytique', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        try {
            const tenantId = req.user.tenant_id;
            const [secteurs, ca, dep] = await Promise.all([
                req.db.query(`SELECT * FROM secteurs WHERE tenant_id = $1 ORDER BY id`, [tenantId]),
                req.db.query(
                    `SELECT p.secteur_id, COALESCE(SUM(lc.sous_total), 0) as total
                     FROM lignes_commande lc
                     JOIN produits p ON lc.produit_id = p.id
                     JOIN commandes c ON lc.commande_id = c.id
                     WHERE c.tenant_id = $1 AND c.statut != 'ANNULEE' AND c.deleted_at IS NULL
                     GROUP BY p.secteur_id`,
                    [tenantId]
                ),
                req.db.query(
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

    router.get('/releves-bancaires', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const [releves, candidats] = await Promise.all([
            req.db.query(
                `SELECT rb.*, p.reference_transaction, p.methode_paiement, cl.nom as client_nom
                 FROM releves_bancaires rb
                 LEFT JOIN paiements p ON rb.paiement_id = p.id
                 LEFT JOIN clients cl ON p.client_id = cl.id
                 WHERE rb.tenant_id = $1
                 ORDER BY rb.date_operation DESC LIMIT 200`,
                [tenantId]
            ),
            // Paiements validés pas encore liés à une ligne de relevé : base de recherche pour la
            // suggestion de rapprochement automatique ci-dessous.
            req.db.query(
                `SELECT p.id, p.montant, p.methode_paiement, p.date_paiement, cl.nom as client_nom
                 FROM paiements p
                 LEFT JOIN clients cl ON p.client_id = cl.id
                 WHERE p.tenant_id = $1 AND p.statut = 'VALIDE'
                   AND p.id NOT IN (SELECT paiement_id FROM releves_bancaires WHERE paiement_id IS NOT NULL AND tenant_id = $1)`,
                [tenantId]
            ),
        ]);

        // Comparaison de montants/dates faite en JS plutôt qu'en SQL, pour rester portable
        // pg-mem/PostgreSQL — même contrainte que le calcul des récoltes proches du dashboard.
        const avecSuggestions = releves.rows.map((rb) => {
            if (rb.rapproche) return { ...rb, suggestion: null };
            const dateOp = new Date(rb.date_operation).getTime();
            const montantRb = Number(rb.montant);
            let meilleur = null;
            let meilleurEcartJours = Infinity;
            for (const p of candidats.rows) {
                if (Math.abs(Number(p.montant) - montantRb) > 1) continue; // tolérance d'arrondi
                const ecartJours = Math.abs(new Date(p.date_paiement).getTime() - dateOp) / 86400000;
                if (ecartJours <= 5 && ecartJours < meilleurEcartJours) {
                    meilleur = p;
                    meilleurEcartJours = ecartJours;
                }
            }
            return { ...rb, suggestion: meilleur };
        });

        res.json(avecSuggestions);
    });

    /**
     * Import en masse d'un relevé bancaire déjà normalisé côté client (le mapping des colonnes du
     * fichier CSV/Excel vers {date_operation, libelle, montant, type_operation} se fait dans
     * l'interface, où le comptable voit un aperçu avant de confirmer). Remplace la saisie ligne par
     * ligne pour un vrai relevé — reste compatible avec elle (POST /releves-bancaires) au besoin.
     */
    router.post('/releves-bancaires/import', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { lignes } = req.body;
        if (!Array.isArray(lignes) || lignes.length === 0) {
            return res.status(400).json({ erreur: 'Aucune ligne à importer.' });
        }
        if (lignes.length > 1000) {
            return res.status(400).json({ erreur: 'Trop de lignes en un seul import (limite 1000).' });
        }

        let inserees = 0;
        const rejetees = [];
        for (let i = 0; i < lignes.length; i++) {
            const { date_operation, libelle, montant, type_operation } = lignes[i] || {};
            const montantNum = Number(montant);
            if (!date_operation || !libelle || !['CREDIT', 'DEBIT'].includes(type_operation)) {
                rejetees.push({ ligne: i + 1, raison: 'Date, libellé ou type manquant/invalide.' });
                continue;
            }
            if (!Number.isFinite(montantNum) || montantNum <= 0) {
                rejetees.push({ ligne: i + 1, raison: 'Montant invalide.' });
                continue;
            }
            try {
                await req.db.query(
                    `INSERT INTO releves_bancaires (tenant_id, date_operation, libelle, montant, type_operation, cree_par)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [req.user.tenant_id, date_operation, libelle, montantNum, type_operation, req.user.id]
                );
                inserees++;
            } catch (err) {
                rejetees.push({ ligne: i + 1, raison: 'Date invalide ou erreur d’insertion.' });
            }
        }

        await logAudit(req.db, {
            table: 'releves_bancaires',
            rowId: null,
            action: 'CREATE',
            userId: req.user.id,
            tenantId: req.user.tenant_id,
            details: { import: true, inserees, rejetees: rejetees.length },
        });
        res.status(201).json({ inserees, rejetees });
    });

    router.post('/releves-bancaires', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { date_operation, libelle, montant, type_operation } = req.body;
        if (!date_operation || !libelle || !montant || !type_operation) {
            return res.status(400).json({ erreur: 'Date, libellé, montant et type sont requis.' });
        }
        try {
            const result = await req.db.query(
                `INSERT INTO releves_bancaires (tenant_id, date_operation, libelle, montant, type_operation, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [req.user.tenant_id, date_operation, libelle, montant, type_operation, req.user.id]
            );
            await logAudit(req.db, { table: 'releves_bancaires', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'ajout de l'opération bancaire." });
        }
    });

    router.put('/releves-bancaires/:id/rapprocher', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { paiement_id } = req.body;
        try {
            if (paiement_id) {
                const paiementRes = await req.db.query(`SELECT id FROM paiements WHERE id = $1 AND tenant_id = $2`, [paiement_id, req.user.tenant_id]);
                if (paiementRes.rows.length === 0) return res.status(400).json({ erreur: 'Paiement invalide.' });
            }
            const result = await req.db.query(
                `UPDATE releves_bancaires SET paiement_id = $1, rapproche = TRUE, rapproche_par = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
                [paiement_id, req.user.id, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
            await logAudit(req.db, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { paiement_id, rapproche: true } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du rapprochement.' });
        }
    });

    router.put('/releves-bancaires/:id/annuler-rapprochement', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await req.db.query(
            `UPDATE releves_bancaires SET paiement_id = NULL, rapproche = FALSE, rapproche_par = NULL WHERE id = $1 AND tenant_id = $2 RETURNING *`,
            [req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Opération introuvable.' });
        await logAudit(req.db, { table: 'releves_bancaires', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { rapproche: false } });
        res.json(result.rows[0]);
    });

    return router;
};

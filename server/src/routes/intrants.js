const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ROLES_INTRANTS = ['chef_prod', 'comptable'];
const CATEGORIES_VALIDES = ['Aliment', 'Engrais', 'Phytosanitaire', 'Vétérinaire', 'Semences', 'Autre'];

async function verifierAccesIntrant(db, intrantId, tenantId) {
    const result = await db.query(`SELECT id FROM intrants WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [intrantId, tenantId]);
    return result.rows.length > 0;
}

module.exports = function intrantsRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        const result = await req.db.query(
            `SELECT i.*, s.nom as secteur_nom FROM intrants i
             LEFT JOIN secteurs s ON s.id = i.secteur_id
             WHERE i.tenant_id = $1 AND i.deleted_at IS NULL ORDER BY i.nom`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        const { nom, categorie, unite, secteur_id, seuil_alerte, quantite_initiale } = req.body;
        const nomTrim = String(nom || '').trim();
        if (!nomTrim || !String(unite || '').trim()) {
            return res.status(400).json({ erreur: "Nom et unité sont requis." });
        }
        if (categorie && !CATEGORIES_VALIDES.includes(categorie)) {
            return res.status(400).json({ erreur: 'Catégorie invalide.' });
        }
        try {
            const result = await req.db.query(
                `INSERT INTO intrants (tenant_id, secteur_id, nom, categorie, unite, quantite_stock, seuil_alerte, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [req.user.tenant_id, secteur_id || null, nomTrim, categorie || null, unite.trim(), Number(quantite_initiale) || 0, seuil_alerte || null, req.user.id]
            );
            await logAudit(req.db, { req, table: 'intrants', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'intrant." });
        }
    });

    router.put('/:id', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        const { nom, categorie, unite, secteur_id, seuil_alerte } = req.body;
        if (categorie && !CATEGORIES_VALIDES.includes(categorie)) {
            return res.status(400).json({ erreur: 'Catégorie invalide.' });
        }
        try {
            const result = await req.db.query(
                `UPDATE intrants SET
                    nom = COALESCE($1, nom),
                    categorie = COALESCE($2, categorie),
                    unite = COALESCE($3, unite),
                    secteur_id = $4,
                    seuil_alerte = $5
                 WHERE id = $6 AND tenant_id = $7 AND deleted_at IS NULL RETURNING *`,
                [nom || null, categorie || null, unite || null, secteur_id || null, seuil_alerte ?? null, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Intrant introuvable.' });
            await logAudit(req.db, { req, table: 'intrants', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'intrant." });
        }
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const result = await req.db.query(
            `UPDATE intrants SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Intrant introuvable.' });
        await logAudit(req.db, { req, table: 'intrants', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    router.get('/:id/mouvements', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        if (!(await verifierAccesIntrant(req.db, req.params.id, req.user.tenant_id))) {
            return res.status(404).json({ erreur: 'Intrant introuvable.' });
        }
        const result = await req.db.query(
            `SELECT m.*, l.code_lot, s.nom AS secteur_nom FROM mouvements_intrants m
             LEFT JOIN lots_production l ON l.id = m.lot_id
             LEFT JOIN secteurs s ON s.id = l.secteur_id
             WHERE m.intrant_id = $1 ORDER BY m.cree_le DESC LIMIT 100`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    /**
     * Entrée manuelle de stock (achat direct, don, correction à la hausse) — la réception d'une
     * commande fournisseur liée à un intrant crée son propre mouvement automatiquement (voir
     * routes/fournisseurs.js, PUT /commandes/:id/recevoir), pas besoin de repasser par ici ensuite.
     */
    router.post('/:id/entree', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        const quantite = Number(req.body.quantite);
        if (!(quantite > 0)) return res.status(400).json({ erreur: 'La quantité doit être positive.' });
        if (!(await verifierAccesIntrant(req.db, req.params.id, req.user.tenant_id))) {
            return res.status(404).json({ erreur: 'Intrant introuvable.' });
        }
        const client = req.db;
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE intrants SET quantite_stock = quantite_stock + $1 WHERE id = $2`, [quantite, req.params.id]);
            await client.query(
                `INSERT INTO mouvements_intrants (intrant_id, type, quantite, motif, notes, cree_par) VALUES ($1, 'ENTREE', $2, 'MANUEL', $3, $4)`,
                [req.params.id, quantite, req.body.notes || null, req.user.id]
            );
            await client.query('COMMIT');
            const intrant = await req.db.query(`SELECT * FROM intrants WHERE id = $1`, [req.params.id]);
            await logAudit(req.db, { req, table: 'intrants', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { entree: quantite } });
            res.json(intrant.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de l'entrée." });
        }
    });

    /**
     * Sortie manuelle de stock (consommation constatée hors relevé, perte, correction à la baisse).
     * Contrairement à la déduction automatique déclenchée par un relevé journalier (voir
     * routes/production.js), une sortie manuelle est bloquée si le stock est insuffisant — ici
     * l'utilisateur affirme explicitement une quantité utilisée, pas une simple donnée de terrain à
     * ne jamais perdre.
     */
    router.post('/:id/sortie', requireAuth(pool), checkRole(ROLES_INTRANTS), async (req, res) => {
        const quantite = Number(req.body.quantite);
        if (!(quantite > 0)) return res.status(400).json({ erreur: 'La quantité doit être positive.' });
        const client = req.db;
        try {
            await client.query('BEGIN');
            const intrantRes = await client.query(`SELECT * FROM intrants WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`, [req.params.id, req.user.tenant_id]);
            if (intrantRes.rows.length === 0) throw { statut: 404, message: 'Intrant introuvable.' };
            if (Number(intrantRes.rows[0].quantite_stock) < quantite) {
                throw { statut: 400, message: `Stock insuffisant (${intrantRes.rows[0].quantite_stock} ${intrantRes.rows[0].unite} disponible(s)).` };
            }
            await client.query(`UPDATE intrants SET quantite_stock = quantite_stock - $1 WHERE id = $2`, [quantite, req.params.id]);
            await client.query(
                `INSERT INTO mouvements_intrants (intrant_id, type, quantite, motif, lot_id, notes, cree_par) VALUES ($1, 'SORTIE', $2, 'MANUEL', $3, $4, $5)`,
                [req.params.id, quantite, req.body.lot_id || null, req.body.notes || null, req.user.id]
            );
            await client.query('COMMIT');
            const intrant = await req.db.query(`SELECT * FROM intrants WHERE id = $1`, [req.params.id]);
            await logAudit(req.db, { req, table: 'intrants', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { sortie: quantite } });
            res.json(intrant.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de la sortie." });
        }
    });

    return router;
};

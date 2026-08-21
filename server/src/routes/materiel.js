const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ROLES_MATERIEL = ['comptable'];

module.exports = function materielRoutes(pool) {
    const router = express.Router();

    // -------------------- Inventaire --------------------

    router.get('/', requireAuth(pool), checkRole(ROLES_MATERIEL), async (req, res) => {
        const result = await req.db.query(
            `SELECT e.*, s.nom as secteur_nom, f.nom as fournisseur_nom
             FROM equipements e
             LEFT JOIN secteurs s ON s.id = e.secteur_id
             LEFT JOIN fournisseurs f ON f.id = e.fournisseur_id
             WHERE e.tenant_id = $1 AND e.deleted_at IS NULL ORDER BY e.nom`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/', requireAuth(pool), checkRole(ROLES_MATERIEL), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom, categorie, secteur_id, fournisseur_id, etat, quantite, date_achat, valeur_achat, notes } = req.body;
        if (!nom) return res.status(400).json({ erreur: "Le nom de l'équipement est requis." });
        try {
            const result = await req.db.query(
                `INSERT INTO equipements (tenant_id, nom, categorie, secteur_id, fournisseur_id, etat, quantite, date_achat, valeur_achat, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [
                    tenantId, nom, categorie || null, secteur_id || null, fournisseur_id || null,
                    etat || 'Bon', quantite || 1, date_achat || null, valeur_achat || null, notes || null, req.user.id,
                ]
            );
            await logAudit(req.db, { req, table: 'equipements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'équipement." });
        }
    });

    router.put('/:id', requireAuth(pool), checkRole(ROLES_MATERIEL), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom, categorie, secteur_id, fournisseur_id, etat, quantite, date_achat, valeur_achat, notes } = req.body;
        try {
            const result = await req.db.query(
                `UPDATE equipements SET
                    nom = COALESCE($1, nom), categorie = COALESCE($2, categorie),
                    secteur_id = COALESCE($3, secteur_id), fournisseur_id = COALESCE($4, fournisseur_id),
                    etat = COALESCE($5, etat), quantite = COALESCE($6, quantite),
                    date_achat = COALESCE($7, date_achat), valeur_achat = COALESCE($8, valeur_achat),
                    notes = COALESCE($9, notes)
                 WHERE id = $10 AND tenant_id = $11 AND deleted_at IS NULL RETURNING *`,
                [nom, categorie, secteur_id, fournisseur_id, etat, quantite, date_achat, valeur_achat, notes, req.params.id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
            await logAudit(req.db, { req, table: 'equipements', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'équipement." });
        }
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const result = await req.db.query(
            `UPDATE equipements SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
        await logAudit(req.db, { req, table: 'equipements', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    // -------------------- Entretien --------------------
    // Chaque entretien loggé met à jour equipements.prochain_entretien (dénormalisé pour la liste)
    // et, si un coût est renseigné, génère une dépense — même principe que la réception d'une
    // commande fournisseur (routes/fournisseurs.js /commandes/:id/recevoir).

    router.get('/:id/entretiens', requireAuth(pool), checkRole(ROLES_MATERIEL), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const equipement = await req.db.query(`SELECT id FROM equipements WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
        if (equipement.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
        const result = await req.db.query(
            `SELECT * FROM entretiens_equipement WHERE equipement_id = $1 ORDER BY date_entretien DESC, id DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    router.post('/:id/entretiens', requireAuth(pool), checkRole(ROLES_MATERIEL), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { date_entretien, description, cout, prochain_entretien } = req.body;
        if (!date_entretien) return res.status(400).json({ erreur: "La date de l'entretien est requise." });

        const client = req.db;
        try {
            await client.query('BEGIN');

            const equipementRes = await client.query(
                `SELECT * FROM equipements WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
                [req.params.id, tenantId]
            );
            if (equipementRes.rows.length === 0) throw { statut: 404, message: 'Équipement introuvable.' };
            const equipement = equipementRes.rows[0];

            const entretienRes = await client.query(
                `INSERT INTO entretiens_equipement (equipement_id, date_entretien, description, cout, prochain_entretien, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [equipement.id, date_entretien, description || null, cout || null, prochain_entretien || null, req.user.id]
            );

            await client.query(`UPDATE equipements SET prochain_entretien = $1 WHERE id = $2`, [prochain_entretien || null, equipement.id]);

            let depenseId = null;
            if (cout) {
                const depenseRes = await client.query(
                    `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                    [
                        tenantId, equipement.secteur_id, 'Matériel', cout,
                        `Entretien ${equipement.nom}${description ? ` — ${description}` : ''}`, date_entretien, req.user.id,
                    ]
                );
                depenseId = depenseRes.rows[0].id;
            }

            await client.query('COMMIT');
            await logAudit(req.db, {
                req, table: 'entretiens_equipement', rowId: entretienRes.rows[0].id, action: 'CREATE',
                userId: req.user.id, tenantId, details: { equipement_id: equipement.id, cout, depense_id: depenseId },
            });
            res.status(201).json(entretienRes.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de l'entretien." });
        }
    });

    return router;
};

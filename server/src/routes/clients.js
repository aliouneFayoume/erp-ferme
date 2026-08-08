const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function clientsRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { type } = req.query;
        const params = [req.user.tenant_id];
        let where = 'tenant_id = $1 AND deleted_at IS NULL';
        if (type) {
            params.push(type);
            where += ` AND type_client = $${params.length}`;
        }
        const result = await pool.query(`SELECT * FROM clients WHERE ${where} ORDER BY nom`, params);
        res.json(result.rows);
    });

    router.post('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { nom, type_client, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit, est_abonne } = req.body;
        if (!gps_lat || !gps_lng) {
            return res.status(400).json({ erreur: "Un point GPS précis est obligatoire pour l'adressage client." });
        }
        try {
            const result = await pool.query(
                `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit, est_abonne)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [req.user.tenant_id, nom, type_client, categorie_tarifaire || 'standard', telephone, adresse, gps_lat, gps_lng, limite_credit || 0, !!est_abonne]
            );
            await logAudit(pool, { table: 'clients', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du client (téléphone déjà utilisé ?).' });
        }
    });

    router.put('/:id', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { nom, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit } = req.body;
        try {
            const result = await pool.query(
                `UPDATE clients SET nom = COALESCE($1, nom), categorie_tarifaire = COALESCE($2, categorie_tarifaire),
                        telephone = COALESCE($3, telephone), adresse = COALESCE($4, adresse),
                        gps_lat = COALESCE($5, gps_lat), gps_lng = COALESCE($6, gps_lng),
                        limite_credit = COALESCE($7, limite_credit)
                 WHERE id = $8 AND tenant_id = $9 AND deleted_at IS NULL RETURNING *`,
                [nom, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Client introuvable.' });
            await logAudit(pool, { table: 'clients', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du client.' });
        }
    });

    /**
     * (Re)génère le code d'accès au portail client — un PIN à 6 chiffres à transmettre
     * manuellement au client (téléphone, SMS...), même logique "manuelle pour l'instant" que le
     * téléchargement de facture PDF. Le PIN en clair n'est renvoyé qu'une fois, jamais stocké ni
     * journalisé ; pin_version incrémenté invalide immédiatement toute session portail existante.
     */
    router.post('/:id/pin', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const pin = String(Math.floor(100000 + Math.random() * 900000));
        const pinHash = await bcrypt.hash(pin, 10);
        const result = await pool.query(
            `UPDATE clients SET pin_hash = $1, pin_version = pin_version + 1
             WHERE id = $2 AND deleted_at IS NULL RETURNING id, nom, telephone`,
            [pinHash, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Client introuvable.' });
        await logAudit(pool, { table: 'clients', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { action: 'regeneration_pin_portail' } });
        res.json({ client: result.rows[0], pin });
    });

    router.delete('/:id', requireAuth, checkRole(['admin']), async (req, res) => {
        await pool.query(`UPDATE clients SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
        await logAudit(pool, { table: 'clients', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    return router;
};

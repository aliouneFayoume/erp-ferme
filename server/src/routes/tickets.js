const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function ticketsRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { statut } = req.query;
        const params = [req.user.tenant_id];
        let where = 't.tenant_id = $1 AND t.deleted_at IS NULL';
        if (statut) {
            params.push(statut);
            where += ` AND t.statut = $${params.length}`;
        }
        const result = await pool.query(
            `SELECT t.*, cl.nom as client_nom, cl.telephone as client_telephone, u.nom_complet as assigne_nom
             FROM tickets t
             JOIN clients cl ON t.client_id = cl.id
             LEFT JOIN utilisateurs u ON t.assigne_a = u.id
             WHERE ${where}
             ORDER BY CASE t.priorite WHEN 'URGENTE' THEN 0 WHEN 'HAUTE' THEN 1 WHEN 'NORMALE' THEN 2 ELSE 3 END, t.cree_le DESC
             LIMIT 200`,
            params
        );
        res.json(result.rows);
    });

    router.post('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { client_id, sujet, description, priorite } = req.body;
        if (!client_id || !sujet) {
            return res.status(400).json({ erreur: 'Client et sujet sont obligatoires.' });
        }
        const clientRes = await pool.query(`SELECT id FROM clients WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [client_id, tenantId]);
        if (clientRes.rows.length === 0) return res.status(400).json({ erreur: 'Client invalide.' });
        const result = await pool.query(
            `INSERT INTO tickets (tenant_id, client_id, sujet, description, priorite, cree_par)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [tenantId, client_id, sujet, description || null, priorite || 'NORMALE', req.user.id]
        );
        await logAudit(pool, { table: 'tickets', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
        res.status(201).json(result.rows[0]);
    });

    router.put('/:id', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { statut, priorite, assigne_a } = req.body;
        const result = await pool.query(
            `UPDATE tickets SET statut = COALESCE($1, statut), priorite = COALESCE($2, priorite),
                    assigne_a = COALESCE($3, assigne_a), mis_a_jour_le = CURRENT_TIMESTAMP
             WHERE id = $4 AND tenant_id = $5 AND deleted_at IS NULL RETURNING *`,
            [statut, priorite, assigne_a, req.params.id, tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Ticket introuvable.' });
        await logAudit(pool, { table: 'tickets', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
        res.json(result.rows[0]);
    });

    router.delete('/:id', requireAuth, checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        await pool.query(`UPDATE tickets SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
        await logAudit(pool, { table: 'tickets', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    router.get('/:id/messages', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const ticketRes = await pool.query(`SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [req.params.id, req.user.tenant_id]);
        if (ticketRes.rows.length === 0) return res.status(404).json({ erreur: 'Ticket introuvable.' });
        const result = await pool.query(
            `SELECT m.*, COALESCE(u.nom_complet, cl.nom) as auteur_nom,
                    CASE WHEN m.auteur_client_id IS NOT NULL THEN 'client' ELSE 'staff' END as auteur_type
             FROM ticket_messages m
             LEFT JOIN utilisateurs u ON m.utilisateur_id = u.id
             LEFT JOIN clients cl ON m.auteur_client_id = cl.id
             WHERE m.ticket_id = $1 ORDER BY m.cree_le ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    router.post('/:id/messages', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ erreur: 'Message vide.' });
        const ticketRes = await pool.query(`SELECT id FROM tickets WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [req.params.id, req.user.tenant_id]);
        if (ticketRes.rows.length === 0) return res.status(404).json({ erreur: 'Ticket introuvable.' });

        const result = await pool.query(
            `INSERT INTO ticket_messages (ticket_id, utilisateur_id, message) VALUES ($1, $2, $3) RETURNING *`,
            [req.params.id, req.user.id, message.trim()]
        );
        await pool.query(`UPDATE tickets SET mis_a_jour_le = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        res.status(201).json(result.rows[0]);
    });

    return router;
};

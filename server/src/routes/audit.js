const express = require('express');
const { requireAuth, checkRole } = require('../auth');

module.exports = function auditRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth, checkRole(['admin']), async (req, res) => {
        const result = await pool.query(
            `SELECT a.*, u.nom_complet as utilisateur_nom FROM audit_logs a
             LEFT JOIN utilisateurs u ON a.utilisateur_id = u.id
             ORDER BY a.cree_le DESC LIMIT 100`
        );
        res.json(result.rows);
    });

    return router;
};

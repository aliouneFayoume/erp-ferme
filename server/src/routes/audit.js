const express = require('express');
const { requireAuth, checkRole } = require('../auth');

module.exports = function auditRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const result = await req.db.query(
            `SELECT a.*, u.nom_complet as utilisateur_nom FROM audit_logs a
             LEFT JOIN utilisateurs u ON a.utilisateur_id = u.id
             WHERE a.tenant_id = $1
             ORDER BY a.cree_le DESC LIMIT 100`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    return router;
};

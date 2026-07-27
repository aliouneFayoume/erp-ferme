/** Journal d'audit : trace l'auteur et l'horodatage de chaque action critique (cahier des charges §4). */
async function logAudit(pool, { table, rowId, action, userId, tenantId, details }) {
    await pool.query(
        `INSERT INTO audit_logs (tenant_id, table_name, row_id, action, utilisateur_id, details) VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId ?? null, table, rowId ?? null, action, userId ?? null, details ? JSON.stringify(details) : null]
    );
}

module.exports = { logAudit };

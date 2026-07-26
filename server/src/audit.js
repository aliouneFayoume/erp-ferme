/** Journal d'audit : trace l'auteur et l'horodatage de chaque action critique (cahier des charges §4). */
async function logAudit(pool, { table, rowId, action, userId, details }) {
    await pool.query(
        `INSERT INTO audit_logs (table_name, row_id, action, utilisateur_id, details) VALUES ($1, $2, $3, $4, $5)`,
        [table, rowId ?? null, action, userId ?? null, details ? JSON.stringify(details) : null]
    );
}

module.exports = { logAudit };

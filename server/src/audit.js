/** Journal d'audit : trace l'auteur et l'horodatage de chaque action critique (cahier des charges §4). */
async function logAudit(pool, { table, rowId, action, userId, tenantId, details, req }) {
    // Propage le marqueur d'impersonation + l'identité du superviseur dans CHAQUE écriture d'audit
    // d'une session de dépannage (audit sécurité 2026-08-11, E4) — avant ceci, seules les entrées
    // CONNEXION_SUPPORT/FIN_SUPPORT elles-mêmes le montraient ; toute action faite PENDANT la
    // session (modifier un client, encaisser un paiement...) était indiscernable d'une action
    // normale de l'admin de la ferme. `req` optionnel : les rares appelants sans requête HTTP en
    // cours (creerFerme.js, notamment lors de l'inscription self-service, où aucun superviseur
    // n'est impliqué) omettent ce champ — les colonnes restent alors à leur valeur par défaut,
    // jamais une impersonation.
    const impersonation = !!req?.user?.impersonation;
    const superviseurId = impersonation ? (req.user.supervisorId ?? null) : null;
    await pool.query(
        `INSERT INTO audit_logs (tenant_id, table_name, row_id, action, utilisateur_id, details, impersonation, superviseur_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId ?? null, table, rowId ?? null, action, userId ?? null, details ? JSON.stringify(details) : null, impersonation, superviseurId]
    );
}

module.exports = { logAudit };

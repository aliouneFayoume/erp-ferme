const { chiffrer, dechiffrer } = require('./credentials');

/**
 * Identifiants PayDunya de l'organisation, déchiffrés — ou null si cette organisation n'a pas
 * encore configuré son agrégateur de paiement (voir routes/parametres-paiement.js).
 */
async function getPaydunyaConfig(pool, tenantId) {
    const result = await pool.query(`SELECT * FROM organisation_paydunya_config WHERE tenant_id = $1`, [tenantId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        mode: row.mode,
        masterKey: dechiffrer(row.master_key_chiffre),
        privateKey: dechiffrer(row.private_key_chiffre),
        publicKey: dechiffrer(row.public_key_chiffre),
        token: dechiffrer(row.token_chiffre),
    };
}

/** Enregistre (ou remplace) les identifiants PayDunya d'une organisation, chiffrés au repos. */
async function setPaydunyaConfig(pool, tenantId, { mode, masterKey, privateKey, publicKey, token }, userId) {
    await pool.query(
        `INSERT INTO organisation_paydunya_config (tenant_id, mode, master_key_chiffre, private_key_chiffre, public_key_chiffre, token_chiffre, mis_a_jour_par, mis_a_jour_le)
         VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id) DO UPDATE SET
             mode = EXCLUDED.mode,
             master_key_chiffre = EXCLUDED.master_key_chiffre,
             private_key_chiffre = EXCLUDED.private_key_chiffre,
             public_key_chiffre = EXCLUDED.public_key_chiffre,
             token_chiffre = EXCLUDED.token_chiffre,
             mis_a_jour_par = EXCLUDED.mis_a_jour_par,
             mis_a_jour_le = CURRENT_TIMESTAMP`,
        [tenantId, mode, chiffrer(masterKey), chiffrer(privateKey), chiffrer(publicKey), chiffrer(token), userId]
    );
}

module.exports = { getPaydunyaConfig, setPaydunyaConfig };

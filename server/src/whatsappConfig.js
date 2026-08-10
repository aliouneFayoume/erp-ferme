const { chiffrer, dechiffrer } = require('./credentials');

/**
 * Identifiants WhatsApp d'une organisation, déchiffrés — ou null si non configurés. Même
 * philosophie/structure que paymentConfig.js. Le PREMIER argument doit toujours être une
 * connexion tenant-scopée (req.db), jamais le pool brut — organisation_whatsapp_config est une
 * table stricte (voir rls-policies.sql), une connexion sans contexte n'y verrait jamais rien.
 */
async function getWhatsappConfig(pool, tenantId) {
    const result = await pool.query(`SELECT * FROM organisation_whatsapp_config WHERE tenant_id = $1`, [tenantId]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
        accessToken: dechiffrer(row.access_token_chiffre),
        phoneNumberId: dechiffrer(row.phone_number_id_chiffre),
        templateNom: row.template_nom,
        templateLangue: row.template_langue,
    };
}

/** Enregistre (ou remplace) les identifiants WhatsApp d'une organisation, chiffrés au repos. */
async function setWhatsappConfig(pool, tenantId, { accessToken, phoneNumberId, templateNom, templateLangue }, userId) {
    await pool.query(
        `INSERT INTO organisation_whatsapp_config (tenant_id, access_token_chiffre, phone_number_id_chiffre, template_nom, template_langue, mis_a_jour_par, mis_a_jour_le)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id) DO UPDATE SET
             access_token_chiffre = EXCLUDED.access_token_chiffre,
             phone_number_id_chiffre = EXCLUDED.phone_number_id_chiffre,
             template_nom = EXCLUDED.template_nom,
             template_langue = EXCLUDED.template_langue,
             mis_a_jour_par = EXCLUDED.mis_a_jour_par,
             mis_a_jour_le = CURRENT_TIMESTAMP`,
        [tenantId, chiffrer(accessToken), chiffrer(phoneNumberId), templateNom || 'hello_world', templateLangue || 'en_US', userId]
    );
}

module.exports = { getWhatsappConfig, setWhatsappConfig };

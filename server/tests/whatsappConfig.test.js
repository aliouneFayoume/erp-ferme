const { createTestPool, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');
const { getWhatsappConfig, setWhatsappConfig } = require('../src/whatsappConfig');

describe('whatsappConfig — get/setWhatsappConfig', () => {
    let pool;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test');
    });

    afterEach(async () => {
        await pool.end();
    });

    test('renvoie null si aucune configuration n\'existe', async () => {
        const config = await getWhatsappConfig(pool, tenantId);
        expect(config).toBeNull();
    });

    test('enregistre puis relit une configuration, déchiffrée correctement', async () => {
        await setWhatsappConfig(pool, tenantId, { accessToken: 'mon-jeton-secret', phoneNumberId: '123456789' }, null);

        const config = await getWhatsappConfig(pool, tenantId);

        expect(config.accessToken).toBe('mon-jeton-secret');
        expect(config.phoneNumberId).toBe('123456789');
        expect(config.templateNom).toBe('hello_world');
        expect(config.templateLangue).toBe('en_US');
    });

    test('les identifiants sont chiffrés au repos (pas lisibles en clair dans la colonne)', async () => {
        await setWhatsappConfig(pool, tenantId, { accessToken: 'mon-jeton-secret', phoneNumberId: '123456789' }, null);

        const brut = await pool.query(`SELECT access_token_chiffre, phone_number_id_chiffre FROM organisation_whatsapp_config WHERE tenant_id = $1`, [tenantId]);

        expect(brut.rows[0].access_token_chiffre).not.toContain('mon-jeton-secret');
        expect(brut.rows[0].phone_number_id_chiffre).not.toContain('123456789');
    });

    test('remplace une configuration existante (ON CONFLICT)', async () => {
        await setWhatsappConfig(pool, tenantId, { accessToken: 'ancien-jeton', phoneNumberId: '111' }, null);
        await setWhatsappConfig(pool, tenantId, { accessToken: 'nouveau-jeton', phoneNumberId: '222' }, null);

        const config = await getWhatsappConfig(pool, tenantId);
        expect(config.accessToken).toBe('nouveau-jeton');
        expect(config.phoneNumberId).toBe('222');

        const compte = await pool.query(`SELECT COUNT(*) FROM organisation_whatsapp_config WHERE tenant_id = $1`, [tenantId]);
        expect(Number(compte.rows[0].count)).toBe(1);
    });
});

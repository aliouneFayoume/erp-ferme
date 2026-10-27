const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

jest.mock('../src/paydunya');
jest.mock('../src/paymentConfig');
jest.mock('../src/whatsapp');
const { creerFacture } = require('../src/paydunya');
const { getPaydunyaConfig } = require('../src/paymentConfig');
const { envoyerMessageWhatsapp } = require('../src/whatsapp');

describe('sécurité finance — initiation de paiement et relance manuelle', () => {
    let pool;
    let app;
    let tenantId;
    let token;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [tenantId]);
        app = buildApp(pool, ['finance']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        getPaydunyaConfig.mockResolvedValue({ mode: 'test', masterKey: 'mk', privateKey: 'pk', publicKey: 'pubk', token: 'tk' });
        creerFacture.mockResolvedValue({ token: 'tok-1', url: 'https://paydunya.test/x' });
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerFactureDue(montant = 5000) {
        const client = await creerClient(pool, { tenant_id: tenantId, telephone: '+221771112233' });
        const commande = (await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-F', $2, 'EN_ATTENTE', $3) RETURNING id`,
            [tenantId, client.id, montant]
        )).rows[0];
        const facture = (await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', $3) RETURNING id`,
            [tenantId, commande.id, montant]
        )).rows[0];
        return { client, commandeId: commande.id, factureId: facture.id };
    }

    const initier = (corps) => request(app).post('/api/finance/paiements/initier').set('Authorization', `Bearer ${token}`).send(corps);

    test.each([-10, 0, 1.5, '5000', 5001])('un montant %p est refusé et PayDunya n\'est pas appelé', async (montant) => {
        const { client, commandeId } = await creerFactureDue(5000);
        const res = await initier({ commande_id: commandeId, client_id: client.id, montant });
        expect(res.status).toBe(400);
        expect(creerFacture).not.toHaveBeenCalled();
    });

    test('le client du paiement est celui de la commande, pas le client_id du corps', async () => {
        const { client, commandeId } = await creerFactureDue(5000);
        const autre = await creerClient(pool, { tenant_id: tenantId });
        const res = await initier({ commande_id: commandeId, client_id: autre.id, montant: 3000 });
        expect(res.status).toBe(201);
        expect(res.body.client_id).toBe(client.id);
    });

    test('relance manuelle : une seconde relance dans les 10 minutes est refusée', async () => {
        envoyerMessageWhatsapp.mockResolvedValue({ messages: [{ id: 'wamid.x' }] });
        const { factureId } = await creerFactureDue(5000);
        const url = `/api/finance/factures/${factureId}/rappel-whatsapp`;
        expect((await request(app).post(url).set('Authorization', `Bearer ${token}`)).status).toBe(200);
        const seconde = await request(app).post(url).set('Authorization', `Bearer ${token}`);
        expect(seconde.status).toBe(429);
        expect(envoyerMessageWhatsapp).toHaveBeenCalledTimes(1);

        // Passé le délai, la relance repart.
        await pool.query(`UPDATE factures SET dernier_rappel_le = $1 WHERE id = $2`, [new Date(Date.now() - 11 * 60 * 1000), factureId]);
        expect((await request(app).post(url).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    });
});

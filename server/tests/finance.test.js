const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

jest.mock('../src/paydunya');
jest.mock('../src/paymentConfig');
jest.mock('../src/whatsapp');
const { confirmerFacture } = require('../src/paydunya');
const { getPaydunyaConfig } = require('../src/paymentConfig');
const { envoyerMessageWhatsapp } = require('../src/whatsapp');

const CREDENTIALS_FACTICES = { mode: 'test', masterKey: 'mk', privateKey: 'pk', publicKey: 'pubk', token: 'tk' };

/** Crée une commande + facture + paiement EN_ATTENTE prêts à être validés par l'IPN. */
async function creerCommandeEtPaiementEnAttente(pool, tenantId, { typeClient = 'B2B', limiteCredit = 1000000, montant = 10000, referenceInterne = null } = {}) {
    const client = await creerClient(pool, { tenant_id: tenantId, type_client: typeClient, limite_credit: limiteCredit });
    await pool.query(
        `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-TEST', $2, 'EN_ATTENTE', $3) RETURNING id`,
        [tenantId, client.id, montant]
    );
    const commande = (await pool.query(`SELECT id FROM commandes WHERE client_id = $1`, [client.id])).rows[0];
    await pool.query(
        `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', $3)`,
        [tenantId, commande.id, montant]
    );
    if (typeClient === 'B2B') {
        await pool.query(`UPDATE clients SET solde_encours = solde_encours + $1 WHERE id = $2`, [montant, client.id]);
    }
    const token = `paydunya-test-token-${Date.now()}`;
    await pool.query(
        `INSERT INTO paiements (tenant_id, commande_id, client_id, montant, methode_paiement, reference_transaction, reference_interne, statut)
         VALUES ($1, $2, $3, $4, 'WAVE', $5, $6, 'EN_ATTENTE')`,
        [tenantId, commande.id, client.id, montant, token, referenceInterne]
    );
    return { client, commande, token, montant };
}

describe('finance — IPN PayDunya', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['finance']);
        confirmerFacture.mockReset();
        getPaydunyaConfig.mockReset();
        getPaydunyaConfig.mockResolvedValue(CREDENTIALS_FACTICES);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('une IPN confirmée "completed" marque le paiement VALIDE et solde la facture', async () => {
        const { commande, token, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 10000 });
        confirmerFacture.mockResolvedValue({ status: 'completed', montant, providerReference: 'PD-REF-1' });

        const res = await request(app)
            .post('/api/finance/paiements/ipn')
            .send({ data: { token } });

        expect(res.status).toBe(200);
        expect(confirmerFacture).toHaveBeenCalledWith(token, CREDENTIALS_FACTICES);

        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('VALIDE');

        const facture = await pool.query(`SELECT statut, montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('PAYEE');
        expect(Number(facture.rows[0].montant_restant)).toBe(0);
    });

    test('une IPN dupliquée (même token) ne crédite pas deux fois', async () => {
        const { client, commande, token, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { typeClient: 'B2B', limiteCredit: 1000000, montant: 10000 });
        confirmerFacture.mockResolvedValue({ status: 'completed', montant, providerReference: 'PD-REF-2' });

        const premier = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });
        expect(premier.status).toBe(200);

        const encoursApresPremier = (await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id])).rows[0].solde_encours;

        // Rejeu de la même IPN (retry légitime de PayDunya, ou tentative malveillante) : ne doit
        // rien créditer une seconde fois, mais répondre 200 (idempotence) plutôt qu'une erreur.
        const second = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });
        expect(second.status).toBe(200);

        const encoursApresSecond = (await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id])).rows[0].solde_encours;
        expect(Number(encoursApresSecond)).toBe(Number(encoursApresPremier));

        const facture = await pool.query(`SELECT montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(Number(facture.rows[0].montant_restant)).toBe(0);
    });

    test('une facture PayDunya toujours "pending" ou "cancelled" ne crédite rien', async () => {
        const { token } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 5000 });
        confirmerFacture.mockResolvedValue({ status: 'cancelled' });

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(200);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('EN_ATTENTE');
    });

    test('une IPN sans token est rejetée', async () => {
        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: {} });

        expect(res.status).toBe(400);
        expect(confirmerFacture).not.toHaveBeenCalled();
    });

    test("un échec de vérification auprès de PayDunya (réseau/API) renvoie une erreur sans créditer", async () => {
        const { token } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 5000 });
        confirmerFacture.mockRejectedValue(new Error('PayDunya indisponible'));

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(502);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('EN_ATTENTE');
    });

    test('une IPN pour un tenant sans agrégateur PayDunya configuré échoue proprement sans créditer', async () => {
        const { token } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 5000 });
        getPaydunyaConfig.mockResolvedValue(null);

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(500);
        expect(confirmerFacture).not.toHaveBeenCalled();
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('EN_ATTENTE');
    });

    // Vérification croisée (audit développement 2026-08-11, liste "Ensuite") : le token authentifie
    // QUELLE facture PayDunya a confirmé, pas que son montant/référence correspondent à ce qu'on
    // attendait réellement.
    test('un montant confirmé différent du montant attendu ne crédite rien et marque le paiement ECHOUE', async () => {
        const { commande, token } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 10000 });
        // PayDunya confirme 5000 alors que 10000 étaient attendus — écart qui doit être détecté,
        // pas silencieusement appliqué (créditerait la moitié de ce qui était dû).
        confirmerFacture.mockResolvedValue({ status: 'completed', montant: 5000, providerReference: 'PD-MISMATCH' });

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(200);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('ECHOUE');
        const facture = await pool.query(`SELECT statut, montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('A_PAYER');
        expect(Number(facture.rows[0].montant_restant)).toBe(10000);
    });

    test('une reference_interne confirmée différente de celle attendue ne crédite rien et marque le paiement ECHOUE', async () => {
        const { commande, token } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 8000, referenceInterne: 'ref-attendue-123' });
        confirmerFacture.mockResolvedValue({ status: 'completed', montant: 8000, providerReference: 'PD-REF-MISMATCH', referenceInterne: 'ref-inattendue-999' });

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(200);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('ECHOUE');
        const facture = await pool.query(`SELECT statut FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('A_PAYER');
    });

    test('montant ET référence cohérents créditent normalement', async () => {
        const { commande, token, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 12000, referenceInterne: 'ref-ok-456' });
        confirmerFacture.mockResolvedValue({ status: 'completed', montant, providerReference: 'PD-OK', referenceInterne: 'ref-ok-456' });

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(200);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('VALIDE');
        const facture = await pool.query(`SELECT statut FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('PAYEE');
    });
});

describe('finance — relance de facture client par WhatsApp (Ferme Massla, identifiants globaux)', () => {
    let pool;
    let app;
    let tenantId;
    let tokenComptable;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        // est_plateforme = TRUE : seule Ferme Massla utilise les identifiants globaux
        // (WHATSAPP_ACCESS_TOKEN) sans avoir besoin de sa propre organisation_whatsapp_config —
        // voir la nouvelle description ci-dessous pour le cas d'une ferme cliente normale.
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [tenantId]);
        tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        app = buildApp(pool, ['finance']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerFactureAvecClient(overrides = {}) {
        const client = await creerClient(pool, { tenant_id: tenantId, telephone: '+221771112233', ...overrides });
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-WA', $2, 'EN_ATTENTE', 5000)`,
            [tenantId, client.id]
        );
        const commande = (await pool.query(`SELECT id FROM commandes WHERE client_id = $1`, [client.id])).rows[0];
        const facture = await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', 5000) RETURNING id`,
            [tenantId, commande.id]
        );
        return facture.rows[0].id;
    }

    test('envoie un rappel WhatsApp au numéro du client', async () => {
        envoyerMessageWhatsapp.mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
        const factureId = await creerFactureAvecClient();

        const res = await request(app)
            .post(`/api/finance/factures/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(200);
        expect(res.body.envoye).toBe(true);
        // config: undefined -> whatsapp.js retombe sur les identifiants globaux (server/.env),
        // jamais une configuration par ferme pour Ferme Massla elle-même.
        expect(envoyerMessageWhatsapp).toHaveBeenCalledWith('+221771112233', { config: undefined });

        const audit = await pool.query(`SELECT * FROM audit_logs WHERE tenant_id = $1 AND action = 'RAPPEL_WHATSAPP'`, [tenantId]);
        expect(audit.rows).toHaveLength(1);
    });

    test("rejette si le client n'a pas de numéro de téléphone", async () => {
        const factureId = await creerFactureAvecClient({ telephone: '' });

        const res = await request(app)
            .post(`/api/finance/factures/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(400);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });

    test('renvoie 404 pour une facture inexistante', async () => {
        const res = await request(app)
            .post(`/api/finance/factures/999999/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);
        expect(res.status).toBe(404);
    });

    test("une facture d'une AUTRE organisation n'est jamais accessible", async () => {
        const autreTenant = await creerOrganisation(pool, 'Autre Ferme');
        const autreClient = await creerClient(pool, { tenant_id: autreTenant, telephone: '+221799998877' });
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-AUTRE', $2, 'EN_ATTENTE', 5000)`,
            [autreTenant, autreClient.id]
        );
        const commande = (await pool.query(`SELECT id FROM commandes WHERE client_id = $1`, [autreClient.id])).rows[0];
        const facture = await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', 5000) RETURNING id`,
            [autreTenant, commande.id]
        );

        const res = await request(app)
            .post(`/api/finance/factures/${facture.rows[0].id}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(404);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });
});

describe('finance — relance de facture client par WhatsApp (ferme cliente normale)', () => {
    let pool;
    let app;
    let tenantId;
    let tokenComptable;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool); // est_plateforme reste FALSE par défaut
        tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        app = buildApp(pool, ['finance']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerFactureAvecClient() {
        const client = await creerClient(pool, { tenant_id: tenantId, telephone: '+221771112233' });
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-WA', $2, 'EN_ATTENTE', 5000)`,
            [tenantId, client.id]
        );
        const commande = (await pool.query(`SELECT id FROM commandes WHERE client_id = $1`, [client.id])).rows[0];
        const facture = await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', 5000) RETURNING id`,
            [tenantId, commande.id]
        );
        return facture.rows[0].id;
    }

    test("sans sa propre configuration WhatsApp, la relance échoue avec un message clair (pas les identifiants de Massla)", async () => {
        const factureId = await creerFactureAvecClient();

        const res = await request(app)
            .post(`/api/finance/factures/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/pas configuré/i);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });

    test('avec sa propre configuration WhatsApp, la relance utilise ces identifiants (pas ceux de Massla)', async () => {
        envoyerMessageWhatsapp.mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
        const { setWhatsappConfig } = require('../src/whatsappConfig');
        await setWhatsappConfig(pool, tenantId, { accessToken: 'jeton-de-cette-ferme', phoneNumberId: '999888777' }, null);
        const factureId = await creerFactureAvecClient();

        const res = await request(app)
            .post(`/api/finance/factures/${factureId}/rappel-whatsapp`)
            .set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(200);
        expect(envoyerMessageWhatsapp).toHaveBeenCalledWith(
            '+221771112233',
            expect.objectContaining({ config: expect.objectContaining({ accessToken: 'jeton-de-cette-ferme', phoneNumberId: '999888777' }) })
        );
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerClient, creerProduitAvecStock, tokenPour } = require('./helpers/testApp');

jest.mock('../src/paydunya');
const { confirmerFacture } = require('../src/paydunya');

/** Crée une commande + facture + paiement EN_ATTENTE prêts à être validés par l'IPN. */
async function creerCommandeEtPaiementEnAttente(pool, { typeClient = 'B2B', limiteCredit = 1000000, montant = 10000 } = {}) {
    const client = await creerClient(pool, { type_client: typeClient, limite_credit: limiteCredit });
    await pool.query(
        `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-TEST', $1, 'EN_ATTENTE', $2) RETURNING id`,
        [client.id, montant]
    );
    const commande = (await pool.query(`SELECT id FROM commandes WHERE client_id = $1`, [client.id])).rows[0];
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, CURRENT_DATE, 'A_PAYER', $2)`,
        [commande.id, montant]
    );
    if (typeClient === 'B2B') {
        await pool.query(`UPDATE clients SET solde_encours = solde_encours + $1 WHERE id = $2`, [montant, client.id]);
    }
    const token = `paydunya-test-token-${Date.now()}`;
    await pool.query(
        `INSERT INTO paiements (commande_id, client_id, montant, methode_paiement, reference_transaction, statut)
         VALUES ($1, $2, $3, 'WAVE', $4, 'EN_ATTENTE')`,
        [commande.id, client.id, montant, token]
    );
    return { client, commande, token, montant };
}

describe('finance — IPN PayDunya', () => {
    let pool;
    let app;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['finance']);
        confirmerFacture.mockReset();
    });

    afterEach(async () => {
        await pool.end();
    });

    test('une IPN confirmée "completed" marque le paiement VALIDE et solde la facture', async () => {
        const { commande, token, montant } = await creerCommandeEtPaiementEnAttente(pool, { montant: 10000 });
        confirmerFacture.mockResolvedValue({ status: 'completed', montant, providerReference: 'PD-REF-1' });

        const res = await request(app)
            .post('/api/finance/paiements/ipn')
            .send({ data: { token } });

        expect(res.status).toBe(200);
        expect(confirmerFacture).toHaveBeenCalledWith(token);

        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('VALIDE');

        const facture = await pool.query(`SELECT statut, montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('PAYEE');
        expect(Number(facture.rows[0].montant_restant)).toBe(0);
    });

    test('une IPN dupliquée (même token) ne crédite pas deux fois', async () => {
        const { client, commande, token, montant } = await creerCommandeEtPaiementEnAttente(pool, { typeClient: 'B2B', limiteCredit: 1000000, montant: 10000 });
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
        const { token } = await creerCommandeEtPaiementEnAttente(pool, { montant: 5000 });
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
        const { token } = await creerCommandeEtPaiementEnAttente(pool, { montant: 5000 });
        confirmerFacture.mockRejectedValue(new Error('PayDunya indisponible'));

        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

        expect(res.status).toBe(502);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [token]);
        expect(paiement.rows[0].statut).toBe('EN_ATTENTE');
    });
});

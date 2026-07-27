const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, tokenPour } = require('./helpers/testApp');

/** Crée une commande + facture + paiement EN_ATTENTE prêts à être validés par le webhook. */
async function creerCommandeEtPaiementEnAttente(pool, tenantId, { typeClient = 'B2B', limiteCredit = 1000000, montant = 10000 } = {}) {
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
    const reference = `WAVE-TEST-${Date.now()}`;
    await pool.query(
        `INSERT INTO paiements (tenant_id, commande_id, client_id, montant, methode_paiement, reference_transaction, statut)
         VALUES ($1, $2, $3, $4, 'WAVE', $5, 'EN_ATTENTE')`,
        [tenantId, commande.id, client.id, montant, reference]
    );
    return { client, commande, reference, montant };
}

describe('finance — webhook paiement', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['finance']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un webhook valide marque le paiement VALIDE et solde la facture', async () => {
        const { commande, reference, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 10000 });

        const res = await request(app)
            .post('/api/finance/paiements/webhook')
            .send({ reference_transaction: reference, statut_paiement: 'SUCCESS', montant, provider: 'WAVE' });

        expect(res.status).toBe(200);

        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [reference]);
        expect(paiement.rows[0].statut).toBe('VALIDE');

        const facture = await pool.query(`SELECT statut, montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('PAYEE');
        expect(Number(facture.rows[0].montant_restant)).toBe(0);
    });

    test('un webhook dupliqué (même référence) ne crédite pas deux fois', async () => {
        const { client, commande, reference, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { typeClient: 'B2B', limiteCredit: 1000000, montant: 10000 });

        const premier = await request(app)
            .post('/api/finance/paiements/webhook')
            .send({ reference_transaction: reference, statut_paiement: 'SUCCESS', montant, provider: 'WAVE' });
        expect(premier.status).toBe(200);

        const encoursApresPremier = (await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id])).rows[0].solde_encours;

        // Rejeu du même webhook (retry légitime du provider, ou tentative malveillante) : doit échouer proprement.
        const second = await request(app)
            .post('/api/finance/paiements/webhook')
            .send({ reference_transaction: reference, statut_paiement: 'SUCCESS', montant, provider: 'WAVE' });
        expect(second.status).toBe(500);

        const encoursApresSecond = (await pool.query(`SELECT solde_encours FROM clients WHERE id = $1`, [client.id])).rows[0].solde_encours;
        expect(Number(encoursApresSecond)).toBe(Number(encoursApresPremier));

        const facture = await pool.query(`SELECT montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(Number(facture.rows[0].montant_restant)).toBe(0);
    });

    test('un webhook avec statut_paiement différent de SUCCESS est rejeté sans effet', async () => {
        const { reference, montant } = await creerCommandeEtPaiementEnAttente(pool, tenantId, { montant: 5000 });

        const res = await request(app)
            .post('/api/finance/paiements/webhook')
            .send({ reference_transaction: reference, statut_paiement: 'FAILED', montant });

        expect(res.status).toBe(400);
        const paiement = await pool.query(`SELECT statut FROM paiements WHERE reference_transaction = $1`, [reference]);
        expect(paiement.rows[0].statut).toBe('EN_ATTENTE');
    });
});

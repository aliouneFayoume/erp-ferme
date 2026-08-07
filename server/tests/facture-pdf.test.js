const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

/** Crée une commande + facture + ligne de commande, prête à être facturée en PDF. */
async function creerCommandeEtFacture(pool, tenantId, { montantRestant = 10000, dateEcheance = null } = {}) {
    const client = await creerClient(pool, { tenant_id: tenantId, type_client: 'B2C' });
    const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, prix_unitaire_b2c: 5000, quantite_disponible: 100 });
    const commandeRes = await pool.query(
        `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-FACT-TEST', $2, 'EN_ATTENTE', $3) RETURNING *`,
        [tenantId, client.id, montantRestant]
    );
    const commande = commandeRes.rows[0];
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, 2, 5000, $3)`,
        [commande.id, produit.id, montantRestant]
    );
    const echeance = dateEcheance || new Date().toISOString().slice(0, 10);
    const factureRes = await pool.query(
        `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, $3, 'A_PAYER', $4) RETURNING *`,
        [tenantId, commande.id, echeance, montantRestant]
    );
    return { client, produit, commande, facture: factureRes.rows[0] };
}

describe('finance — génération PDF de facture', () => {
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

    test('génère un PDF valide pour une facture existante', async () => {
        const { facture } = await creerCommandeEtFacture(pool, tenantId);
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get(`/api/finance/factures/${facture.id}/pdf`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.headers['content-disposition']).toContain('facture-CMD-FACT-TEST.pdf');
        expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    });

    test('facture introuvable renvoie 404', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get('/api/finance/factures/999999/pdf').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
    });

    test("une facture d'une autre organisation renvoie 404 (isolation)", async () => {
        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const { facture } = await creerCommandeEtFacture(pool, autreTenantId);
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get(`/api/finance/factures/${facture.id}/pdf`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
    });

    test("une facture non payée dont l'échéance est dépassée bascule automatiquement en retard", async () => {
        const hier = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const { facture } = await creerCommandeEtFacture(pool, tenantId, { montantRestant: 8000, dateEcheance: hier });
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get('/api/finance/factures').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const mise_a_jour = res.body.find((f) => f.id === facture.id);
        expect(mise_a_jour.statut).toBe('EN_RETARD');
    });

    test("une facture dont l'échéance est aujourd'hui même ne bascule pas encore en retard", async () => {
        const aujourdhui = new Date().toISOString().slice(0, 10);
        const { facture } = await creerCommandeEtFacture(pool, tenantId, { montantRestant: 8000, dateEcheance: aujourdhui });
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get('/api/finance/factures').set('Authorization', `Bearer ${token}`);

        const mise_a_jour = res.body.find((f) => f.id === facture.id);
        expect(mise_a_jour.statut).toBe('A_PAYER');
    });

    test("une facture non échue reste à payer (ne bascule pas en retard trop tôt)", async () => {
        const demain = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
        const { facture } = await creerCommandeEtFacture(pool, tenantId, { montantRestant: 8000, dateEcheance: demain });
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });

        const res = await request(app).get('/api/finance/factures').set('Authorization', `Bearer ${token}`);

        const mise_a_jour = res.body.find((f) => f.id === facture.id);
        expect(mise_a_jour.statut).toBe('A_PAYER');
    });
});

const request = require('supertest');
const {
    createTestPool,
    buildApp,
    seedRolesEtSecteurs,
    creerClient,
    creerProduitAvecStock,
    creerUtilisateurEtToken,
} = require('./helpers/testApp');

/** Commande + facture + livraison A_FAIRE, prêtes à être finalisées par le livreur. */
async function creerCommandeEtLivraison(pool, { livreurId, typeClient = 'B2C', montant = 10000 } = {}) {
    const client = await creerClient(pool, { type_client: typeClient, limite_credit: 1000000 });
    const produit = await creerProduitAvecStock(pool);
    const commandeRes = await pool.query(
        `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-LOG-TEST', $1, 'PREPAREE', $2) RETURNING *`,
        [client.id, montant]
    );
    const commande = commandeRes.rows[0];
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, 1, $3, $3)`,
        [commande.id, produit.id, montant]
    );
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, CURRENT_DATE, 'A_PAYER', $2)`,
        [commande.id, montant]
    );
    const livraisonRes = await pool.query(
        `INSERT INTO livraisons (commande_id, livreur_id, date_prevue, statut) VALUES ($1, $2, CURRENT_DATE, 'A_FAIRE') RETURNING *`,
        [commande.id, livreurId]
    );
    return { client, commande, livraison: livraisonRes.rows[0] };
}

describe('logistique — encaissement à la livraison', () => {
    let pool;
    let app;
    let livreurId;
    let token;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['logistique']);
        token = await creerUtilisateurEtToken(pool, { role: 'livreur', nom_complet: 'Livreur Test' });
        livreurId = require('jsonwebtoken').decode(token).id;
    });

    afterEach(async () => {
        await pool.end();
    });

    test('sans méthode de paiement précisée, encaisse en ESPECES (comportement historique)', async () => {
        const { commande, livraison } = await creerCommandeEtLivraison(pool, { livreurId, montant: 8000 });

        const res = await request(app)
            .put(`/api/logistique/livraisons/${livraison.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'TERMINEE', montant_encaisse: 8000, preuve_livraison: 'Signé par le client' });

        expect(res.status).toBe(200);
        const paiement = await pool.query(`SELECT methode_paiement, montant FROM paiements WHERE commande_id = $1`, [commande.id]);
        expect(paiement.rows[0].methode_paiement).toBe('ESPECES');
        expect(Number(paiement.rows[0].montant)).toBe(8000);
    });

    test('un encaissement Wave enregistre le bon mode et ne crédite pas la caisse chauffeur (espèces uniquement)', async () => {
        const { commande, livraison } = await creerCommandeEtLivraison(pool, { livreurId, montant: 8000 });
        // Date passée explicitement en JS (et non CURRENT_DATE côté SQL) pour matcher exactement
        // le `new Date().toISOString().slice(0, 10)` que la route utilise pour retrouver la caisse
        // du jour — pg-mem ne compare pas toujours DATE et cette chaîne de façon cohérente.
        await pool.query(
            `INSERT INTO caisses_chauffeur (livreur_id, date_caisse, statut, montant_theorique) VALUES ($1, $2, 'OUVERTE', 0)`,
            [livreurId, new Date().toISOString().slice(0, 10)]
        );

        const res = await request(app)
            .put(`/api/logistique/livraisons/${livraison.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'TERMINEE', montant_encaisse: 8000, methode_paiement: 'WAVE', preuve_livraison: 'Reçu Wave' });

        expect(res.status).toBe(200);

        const paiement = await pool.query(`SELECT methode_paiement FROM paiements WHERE commande_id = $1`, [commande.id]);
        expect(paiement.rows[0].methode_paiement).toBe('WAVE');

        const facture = await pool.query(`SELECT statut, montant_restant FROM factures WHERE commande_id = $1`, [commande.id]);
        expect(facture.rows[0].statut).toBe('PAYEE'); // la facture est bien soldée, quel que soit le mode

        const caisse = await pool.query(`SELECT montant_theorique FROM caisses_chauffeur WHERE livreur_id = $1`, [livreurId]);
        expect(Number(caisse.rows[0].montant_theorique)).toBe(0); // pas d'espèces réelles en poche pour du Wave
    });

    test('un encaissement en espèces crédite bien la caisse chauffeur', async () => {
        const { livraison } = await creerCommandeEtLivraison(pool, { livreurId, montant: 5000 });
        // Date passée explicitement en JS (et non CURRENT_DATE côté SQL) pour matcher exactement
        // le `new Date().toISOString().slice(0, 10)` que la route utilise pour retrouver la caisse
        // du jour — pg-mem ne compare pas toujours DATE et cette chaîne de façon cohérente.
        await pool.query(
            `INSERT INTO caisses_chauffeur (livreur_id, date_caisse, statut, montant_theorique) VALUES ($1, $2, 'OUVERTE', 0)`,
            [livreurId, new Date().toISOString().slice(0, 10)]
        );

        await request(app)
            .put(`/api/logistique/livraisons/${livraison.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'TERMINEE', montant_encaisse: 5000, methode_paiement: 'ESPECES', preuve_livraison: 'Signé' });

        const caisse = await pool.query(`SELECT montant_theorique FROM caisses_chauffeur WHERE livreur_id = $1`, [livreurId]);
        expect(Number(caisse.rows[0].montant_theorique)).toBe(5000);
    });

    test('un mode de paiement invalide est rejeté', async () => {
        const { livraison } = await creerCommandeEtLivraison(pool, { livreurId, montant: 5000 });

        const res = await request(app)
            .put(`/api/logistique/livraisons/${livraison.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'TERMINEE', montant_encaisse: 5000, methode_paiement: 'BITCOIN', preuve_livraison: 'Signé' });

        expect(res.status).toBe(400);
    });
});

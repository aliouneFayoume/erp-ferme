const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

async function creerFournisseur(app, token, overrides = {}) {
    const res = await request(app)
        .post('/api/fournisseurs')
        .set('Authorization', `Bearer ${token}`)
        .send({ nom: 'Fournisseur Test', categorie: 'Aliment', ...overrides });
    return res.body;
}

describe('fournisseurs — annuaire, commandes d\'achat, alertes de réappro', () => {
    let pool;
    let app;
    let token;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['fournisseurs']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable' });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un fournisseur puis le liste', async () => {
        await creerFournisseur(app, token, { nom: 'Grainerie du Sahel' });

        const res = await request(app).get('/api/fournisseurs').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].nom).toBe('Grainerie du Sahel');
        expect(res.body[0].nb_livraisons).toBe(0);
        expect(res.body[0].delai_moyen_jours).toBeNull();
    });

    test('crée une commande fournisseur avec plusieurs lignes (intrants en texte libre) et calcule le montant total', async () => {
        const fournisseur = await creerFournisseur(app, token);

        const res = await request(app)
            .post('/api/fournisseurs/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({
                fournisseur_id: fournisseur.id,
                date_livraison_prevue: '2026-09-01',
                lignes: [
                    { designation: 'Aliment ponte 25kg', unite: 'sac', quantite: 10, prix_unitaire: 500 },
                    { designation: 'Vaccin Newcastle', quantite: 2, prix_unitaire: 3000 },
                ],
            });

        expect(res.status).toBe(201);
        expect(Number(res.body.montant_total)).toBe(11000);
        expect(res.body.statut).toBe('COMMANDEE');

        const lignes = await pool.query(`SELECT * FROM lignes_commande_fournisseur WHERE commande_fournisseur_id = $1 ORDER BY id`, [res.body.id]);
        expect(lignes.rows).toHaveLength(2);
        expect(lignes.rows[0].designation).toBe('Aliment ponte 25kg');
        expect(lignes.rows[0].unite).toBe('sac');
    });

    test('liste les commandes fournisseurs avec le nom du fournisseur', async () => {
        const fournisseur = await creerFournisseur(app, token, { nom: 'Semencerie du Fleuve' });
        await request(app)
            .post('/api/fournisseurs/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ fournisseur_id: fournisseur.id, lignes: [{ designation: 'Semences maïs', quantite: 3, prix_unitaire: 2000 }] });

        const res = await request(app).get('/api/fournisseurs/commandes').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].fournisseur_nom).toBe('Semencerie du Fleuve');
        expect(Number(res.body[0].montant_total)).toBe(6000);
    });

    test('réceptionner une commande le jour même donne un délai de 0 jour, jamais négatif', async () => {
        const fournisseur = await creerFournisseur(app, token);
        const commande = (
            await request(app)
                .post('/api/fournisseurs/commandes')
                .set('Authorization', `Bearer ${token}`)
                .send({ fournisseur_id: fournisseur.id, lignes: [{ designation: 'Aliment', quantite: 1, prix_unitaire: 1000 }] })
        ).body;

        await request(app).put(`/api/fournisseurs/commandes/${commande.id}/recevoir`).set('Authorization', `Bearer ${token}`).send({});

        const res = await request(app).get('/api/fournisseurs').set('Authorization', `Bearer ${token}`);
        const f = res.body.find((x) => x.id === fournisseur.id);
        expect(f.delai_moyen_jours).toBe(0);
    });

    test('rejette une ligne sans désignation', async () => {
        const fournisseur = await creerFournisseur(app, token);
        const res = await request(app)
            .post('/api/fournisseurs/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ fournisseur_id: fournisseur.id, lignes: [{ designation: '  ', quantite: 1, prix_unitaire: 100 }] });
        expect(res.status).toBe(400);
    });

    test('réceptionner une commande ne touche pas le stock/catalogue de vente, génère une dépense une seule fois', async () => {
        const fournisseur = await creerFournisseur(app, token, { categorie: 'Vétérinaire' });
        const produit = await creerProduitAvecStock(pool, { quantite_disponible: 50 });

        const commande = (
            await request(app)
                .post('/api/fournisseurs/commandes')
                .set('Authorization', `Bearer ${token}`)
                .send({ fournisseur_id: fournisseur.id, lignes: [{ designation: 'Vaccin', quantite: 20, prix_unitaire: 750 }] })
        ).body;

        const res = await request(app)
            .put(`/api/fournisseurs/commandes/${commande.id}/recevoir`)
            .set('Authorization', `Bearer ${token}`)
            .send({});

        expect(res.status).toBe(200);
        expect(res.body.statut).toBe('RECUE');
        expect(res.body.date_livraison_reelle).not.toBeNull();

        // Le catalogue de vente (produits/stocks) n'a aucun rapport avec les intrants achetés.
        const stock = await pool.query(`SELECT * FROM stocks WHERE produit_id = $1`, [produit.id]);
        expect(Number(stock.rows[0].quantite_disponible)).toBe(50);

        const depenses = await pool.query(`SELECT * FROM depenses WHERE deleted_at IS NULL`);
        expect(depenses.rows).toHaveLength(1);
        expect(Number(depenses.rows[0].montant)).toBe(15000);
        expect(depenses.rows[0].categorie).toBe('Vétérinaire');

        // Une commande déjà reçue ne peut pas être réceptionnée une seconde fois (pas de double dépense).
        const res2 = await request(app)
            .put(`/api/fournisseurs/commandes/${commande.id}/recevoir`)
            .set('Authorization', `Bearer ${token}`)
            .send({});
        expect(res2.status).toBe(400);

        const depensesApres = await pool.query(`SELECT * FROM depenses WHERE deleted_at IS NULL`);
        expect(depensesApres.rows).toHaveLength(1);
    });

    test('annuler une commande ne peut plus être réceptionnée', async () => {
        const fournisseur = await creerFournisseur(app, token);

        const commande = (
            await request(app)
                .post('/api/fournisseurs/commandes')
                .set('Authorization', `Bearer ${token}`)
                .send({ fournisseur_id: fournisseur.id, lignes: [{ designation: 'Semences maïs', quantite: 5, prix_unitaire: 100 }] })
        ).body;

        const res = await request(app).put(`/api/fournisseurs/commandes/${commande.id}/annuler`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.statut).toBe('ANNULEE');

        const recevoir = await request(app).put(`/api/fournisseurs/commandes/${commande.id}/recevoir`).set('Authorization', `Bearer ${token}`).send({});
        expect(recevoir.status).toBe(400);
    });

    test('calcule le délai moyen et le taux de retard après réception', async () => {
        const fournisseur = await creerFournisseur(app, token);

        // Commande livrée pile à la date prévue -> pas de retard.
        await pool.query(
            `INSERT INTO commandes_fournisseurs (numero_commande, fournisseur_id, statut, date_commande, date_livraison_prevue, date_livraison_reelle, montant_total)
             VALUES ('CMF-A', $1, 'RECUE', '2026-01-01', '2026-01-05', '2026-01-05', 1000)`,
            [fournisseur.id]
        );
        // Commande livrée en retard (2 jours après la date prévue).
        await pool.query(
            `INSERT INTO commandes_fournisseurs (numero_commande, fournisseur_id, statut, date_commande, date_livraison_prevue, date_livraison_reelle, montant_total)
             VALUES ('CMF-B', $1, 'RECUE', '2026-01-01', '2026-01-05', '2026-01-07', 1000)`,
            [fournisseur.id]
        );

        const res = await request(app).get('/api/fournisseurs').set('Authorization', `Bearer ${token}`);
        const f = res.body.find((x) => x.id === fournisseur.id);
        expect(f.nb_livraisons).toBe(2);
        expect(f.delai_moyen_jours).toBe(5); // (4 jours + 6 jours) / 2
        expect(f.taux_retard).toBe(50);
    });

    test('signale les produits sous le seuil de réapprovisionnement (stocks.seuil_alerte)', async () => {
        await creerProduitAvecStock(pool, { nom: 'Stock bas', quantite_disponible: 3 });
        await creerProduitAvecStock(pool, { nom: 'Stock ok', quantite_disponible: 500 });
        // seuil_alerte par défaut du schéma = 10 : le premier est sous le seuil, pas le second.

        const res = await request(app).get('/api/fournisseurs/reappro-alertes').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].produit_nom).toBe('Stock bas');
    });

    test('un livreur ne peut pas accéder au module fournisseurs', async () => {
        const tokenLivreur = await creerUtilisateurEtToken(pool, { role: 'livreur' });
        const res = await request(app).get('/api/fournisseurs').set('Authorization', `Bearer ${tokenLivreur}`);
        expect(res.status).toBe(403);
    });
});

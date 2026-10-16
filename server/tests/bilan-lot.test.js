const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerProduitAvecStock, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('bilan par lot — ce que chaque lot rapporte', () => {
    let pool;
    let app;
    let tenantId;
    let secteurId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        secteurId = (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Avicole') RETURNING id`, [tenantId])).rows[0].id;
        app = buildApp(pool, ['production', 'commandes']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerLot(overrides = {}) {
        const l = { tenant: tenantId, code: 'A-1', quantite: 1000, statut: 'TERMINE', ...overrides };
        const r = await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
             VALUES ($1, $2, $3, $4, '2026-08-01', $5) RETURNING *`,
            [l.tenant, secteurId, l.code, l.quantite, l.statut]
        );
        return r.rows[0];
    }
    async function ajouterReleve(lotId, jour, aliment) {
        await pool.query(`INSERT INTO releves_journaliers (lot_id, date_releve, mortalite, conso_aliment_kg) VALUES ($1, $2, 1, $3)`, [lotId, jour, aliment]);
    }
    const bilan = (token, lotId) => request(app).get(`/api/production/lots/${lotId}/bilan`).set('Authorization', `Bearer ${token}`);

    test("calcule la marge : ventes du lot − (aliment valorisé + autres coûts)", async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const lot = await creerLot();
        await ajouterReleve(lot.id, '2026-08-02', 100);
        await ajouterReleve(lot.id, '2026-08-03', 150);

        // prix de l'aliment : 250 kg × 500 = 125 000
        expect((await request(app).put(`/api/production/lots/${lot.id}/prix-aliment`).set('Authorization', `Bearer ${token}`).send({ prix_aliment_kg: 500 })).status).toBe(200);
        // autres coûts : 80 000 + 20 000
        const cout = (body) => request(app).post(`/api/production/lots/${lot.id}/couts`).set('Authorization', `Bearer ${token}`).send(body);
        expect((await cout({ categorie: 'Poussins', libelle: '1000 poussins', montant: 80000 })).status).toBe(201);
        expect((await cout({ categorie: 'Vétérinaire', montant: 20000 })).status).toBe(201);

        // une vente rattachée au lot : 10 poulets à 3 000 = 30 000... on en vend 40 pour dépasser les coûts : 40 × 5 000 = 200 000
        const client = await creerClient(pool, { tenant_id: tenantId });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, secteur_id: secteurId, unite_mesure: 'TETE', prix_unitaire_b2c: 5000, quantite_disponible: 100 });
        const commande = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 40, lot_id: lot.id }] });
        expect(commande.status).toBe(201);

        const res = await bilan(token, lot.id);
        expect(res.status).toBe(200);
        expect(res.body.aliment).toEqual({ kg: 250, prix_kg: 500, cout: 125000 });
        expect(res.body.couts.total_autres).toBe(100000);
        expect(res.body.couts.par_categorie.Poussins).toBe(80000);
        expect(res.body.ventes).toMatchObject({ total: 200000, nb_lignes: 1, sujets_vendus: 40 });
        expect(res.body.total_couts).toBe(225000);
        expect(res.body.marge).toBe(-25000);
        expect(res.body.marge_par_sujet).toBe(-625);
        expect(res.body.complet).toBe(true);
        expect(res.body.manques).toEqual([]);

        // Rien n'est encore payé : la facture est créée avec la commande, 200 000 restent dus
        expect(res.body.ventes).toMatchObject({ encaisse: 0, reste_a_encaisser: 200000 });
        expect(res.body.tresorerie).toBe(-225000);

        // Paiement partiel de 120 000 FCFA (60 %) : l'encaissé suit, la marge (ventes facturées) ne bouge pas
        await pool.query(`UPDATE factures SET montant_restant = 80000, statut = 'PAYEE_PARTIEL' WHERE commande_id = $1`, [commande.body.id]);
        const apres = (await bilan(token, lot.id)).body;
        expect(apres.ventes).toMatchObject({ total: 200000, encaisse: 120000, reste_a_encaisser: 80000 });
        expect(apres.marge).toBe(-25000);
        expect(apres.tresorerie).toBe(-105000);
    });

    test("une commande qui mêle deux lots répartit l'encaissé au prorata de la facture, ligne par ligne", async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const lotA = await creerLot({ code: 'A-1' });
        const lotB = await creerLot({ code: 'B-1' });
        const client = await creerClient(pool, { tenant_id: tenantId });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, secteur_id: secteurId, unite_mesure: 'TETE', prix_unitaire_b2c: 1000, quantite_disponible: 100 });
        const commande = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 30, lot_id: lotA.id }, { produit_id: produit.id, quantite: 10, lot_id: lotB.id }] });
        expect(commande.status).toBe(201); // total 40 000
        await pool.query(`UPDATE factures SET montant_restant = 10000 WHERE commande_id = $1`, [commande.body.id]); // 75 % payé

        expect((await bilan(token, lotA.id)).body.ventes).toMatchObject({ total: 30000, encaisse: 22500 });
        expect((await bilan(token, lotB.id)).body.ventes).toMatchObject({ total: 10000, encaisse: 7500 });
    });

    test("un bilan incomplet le dit : prix d'aliment, poussins et ventes manquants ne sont pas comptés comme zéro en silence", async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const lot = await creerLot();
        await ajouterReleve(lot.id, '2026-08-02', 100);
        const res = await bilan(token, lot.id);
        expect(res.status).toBe(200);
        expect(res.body.aliment.cout).toBeNull();
        expect(res.body.manques.sort()).toEqual(['poussins', 'prix_aliment', 'ventes']);
        expect(res.body.complet).toBe(false);
        expect(res.body.marge_pct).toBeNull();
    });

    test('une commande annulée ou un coût supprimé ne comptent plus', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const lot = await creerLot();
        const client = await creerClient(pool, { tenant_id: tenantId });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, secteur_id: secteurId, unite_mesure: 'TETE', prix_unitaire_b2c: 1000, quantite_disponible: 100 });
        const commande = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 10, lot_id: lot.id }] });
        const cout = await request(app).post(`/api/production/lots/${lot.id}/couts`).set('Authorization', `Bearer ${token}`).send({ categorie: 'Autre', montant: 5000 });

        expect((await bilan(token, lot.id)).body).toMatchObject({ ventes: { total: 10000 }, couts: { total_autres: 5000 } });

        await request(app).put(`/api/commandes/${commande.body.id}/statut`).set('Authorization', `Bearer ${token}`).send({ statut: 'ANNULEE' });
        await request(app).delete(`/api/production/lots/${lot.id}/couts/${cout.body.id}`).set('Authorization', `Bearer ${token}`);

        const apres = (await bilan(token, lot.id)).body;
        expect(apres.ventes.total).toBe(0);
        expect(apres.couts.total_autres).toBe(0);
    });

    test('le bilan est réservé à l\'administrateur et au comptable', async () => {
        const lot = await creerLot();
        const comptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        const chefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId });
        const livreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId });
        expect((await bilan(comptable, lot.id)).status).toBe(200);
        expect((await bilan(chefProd, lot.id)).status).toBe(403);
        expect((await bilan(livreur, lot.id)).status).toBe(403);
    });

    test("isolation : le lot d'une autre ferme est introuvable, et on ne peut pas y rattacher une vente", async () => {
        const autre = await creerOrganisation(pool, 'Autre Ferme');
        const lotAutre = await creerLot({ tenant: autre, code: 'X-1' });
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });

        expect((await bilan(token, lotAutre.id)).status).toBe(404);
        const ajout = await request(app).post(`/api/production/lots/${lotAutre.id}/couts`).set('Authorization', `Bearer ${token}`).send({ categorie: 'Autre', montant: 1 });
        expect(ajout.status).toBe(404);

        const client = await creerClient(pool, { tenant_id: tenantId });
        const produit = await creerProduitAvecStock(pool, { tenant_id: tenantId, secteur_id: secteurId, unite_mesure: 'TETE', prix_unitaire_b2c: 1000, quantite_disponible: 100 });
        const commande = await request(app)
            .post('/api/commandes')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, lignes: [{ produit_id: produit.id, quantite: 1, lot_id: lotAutre.id }] });
        expect(commande.status).toBe(404);
    });

    test('saisies invalides refusées : catégorie inconnue, montant négatif, libellé avec du HTML, prix négatif', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const lot = await creerLot();
        const cout = (body) => request(app).post(`/api/production/lots/${lot.id}/couts`).set('Authorization', `Bearer ${token}`).send(body);
        expect((await cout({ categorie: 'Cadeaux', montant: 10 })).status).toBe(400);
        expect((await cout({ categorie: 'Autre', montant: -5 })).status).toBe(400);
        expect((await cout({ categorie: 'Autre', montant: 'abc' })).status).toBe(400);
        expect((await cout({ categorie: 'Autre', montant: 10, libelle: '<script>x</script>' })).status).toBe(400);
        const prix = await request(app).put(`/api/production/lots/${lot.id}/prix-aliment`).set('Authorization', `Bearer ${token}`).send({ prix_aliment_kg: -1 });
        expect(prix.status).toBe(400);
    });

    test("l'essai autonome livre une ferme démo avec un bilan complet et une marge positive, supprimable en un clic", async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        const { creerFermeEssai } = require('../src/creerFermeEssai');
        const ferme = await creerFermeEssai(pool, { nomFerme: 'Ferme Démo Test', telephone: '+221771110000', source: 'essai' });
        const tokenEssai = require('../src/auth').signToken({ ...ferme.admin, role_nom: 'admin' });

        const lotDemo = (await pool.query(`SELECT id FROM lots_production WHERE tenant_id = $1 AND est_demo = TRUE`, [ferme.tenantId])).rows[0];
        const res = await bilan(tokenEssai, lotDemo.id);
        expect(res.status).toBe(200);
        expect(res.body.complet).toBe(true);
        expect(res.body.ventes.sujets_vendus).toBe(1920);
        expect(res.body.marge).toBeGreaterThan(0);
        expect(res.body.marge_pct).toBeGreaterThan(0);
        expect(res.body.marge_pct).toBeLessThan(25); // une marge d'élevage réaliste, pas flatteuse
        // les ventes de la démo n'ont pas de facture (pour ne pas encombrer Finance) : réputées payées
        expect(res.body.ventes.encaisse).toBe(res.body.ventes.total);
        expect(res.body.ventes.reste_a_encaisser).toBe(0);

        // La démo se supprime d'un coup : lot, ventes, client et produit « démo », sans toucher au reste.
        const essaiApp = buildApp(pool, ['essai', 'production']);
        const del = await request(essaiApp).delete('/api/essai/demo').set('Authorization', `Bearer ${tokenEssai}`);
        expect(del.status).toBe(200);
        const restant = await pool.query(
            `SELECT (SELECT COUNT(*) FROM commandes WHERE tenant_id = $1 AND deleted_at IS NULL)::int AS commandes,
                    (SELECT COUNT(*) FROM clients WHERE tenant_id = $1 AND deleted_at IS NULL)::int AS clients,
                    (SELECT COUNT(*) FROM produits WHERE tenant_id = $1 AND deleted_at IS NULL)::int AS produits`,
            [ferme.tenantId]
        );
        expect(restant.rows[0]).toEqual({ commandes: 0, clients: 0, produits: 0 });
        delete process.env.ESSAI_AUTONOME_ACTIF;
    });
});

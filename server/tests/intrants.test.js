const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('intrants — stock (catalogue + entrées/sorties)', () => {
    let pool;
    let app;
    let tenantId;
    let tokenChefProd;
    let tokenComptable;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId });
        tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        app = buildApp(pool, ['intrants']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un intrant avec une quantité initiale et le liste', async () => {
        const res = await request(app)
            .post('/api/intrants')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ nom: 'Engrais NPK', categorie: 'Engrais', unite: 'kg', quantite_initiale: 200, seuil_alerte: 20 });
        expect(res.status).toBe(201);
        expect(Number(res.body.quantite_stock)).toBe(200);

        const liste = await request(app).get('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(liste.body).toHaveLength(1);
        expect(liste.body[0].nom).toBe('Engrais NPK');
    });

    test('rejette un nom ou une unité manquants', async () => {
        const res = await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Sans unité' });
        expect(res.status).toBe(400);
    });

    test('rejette une catégorie invalide', async () => {
        const res = await request(app)
            .post('/api/intrants')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ nom: 'Test', unite: 'kg', categorie: 'Inconnue' });
        expect(res.status).toBe(400);
    });

    test('une entrée manuelle augmente le stock et journalise le mouvement', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg', quantite_initiale: 10 })
        ).body;

        const res = await request(app)
            .post(`/api/intrants/${intrant.id}/entree`)
            .set('Authorization', `Bearer ${tokenComptable}`)
            .send({ quantite: 40, notes: 'Achat marché' });
        expect(res.status).toBe(200);
        expect(Number(res.body.quantite_stock)).toBe(50);

        const mouvements = await request(app).get(`/api/intrants/${intrant.id}/mouvements`).set('Authorization', `Bearer ${tokenChefProd}`);
        expect(mouvements.body).toHaveLength(1);
        expect(mouvements.body[0].type).toBe('ENTREE');
        expect(mouvements.body[0].motif).toBe('MANUEL');
    });

    test('une sortie manuelle diminue le stock', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg', quantite_initiale: 50 })
        ).body;

        const res = await request(app).post(`/api/intrants/${intrant.id}/sortie`).set('Authorization', `Bearer ${tokenChefProd}`).send({ quantite: 20 });
        expect(res.status).toBe(200);
        expect(Number(res.body.quantite_stock)).toBe(30);
    });

    test('une sortie manuelle est bloquée si le stock est insuffisant', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg', quantite_initiale: 5 })
        ).body;

        const res = await request(app).post(`/api/intrants/${intrant.id}/sortie`).set('Authorization', `Bearer ${tokenChefProd}`).send({ quantite: 20 });
        expect(res.status).toBe(400);

        const inchange = await request(app).get('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(Number(inchange.body[0].quantite_stock)).toBe(5);
    });

    test('rejette une quantité négative ou nulle en entrée comme en sortie', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg', quantite_initiale: 50 })
        ).body;

        const entree = await request(app).post(`/api/intrants/${intrant.id}/entree`).set('Authorization', `Bearer ${tokenChefProd}`).send({ quantite: 0 });
        expect(entree.status).toBe(400);
        const sortie = await request(app).post(`/api/intrants/${intrant.id}/sortie`).set('Authorization', `Bearer ${tokenChefProd}`).send({ quantite: -5 });
        expect(sortie.status).toBe(400);
    });

    test('modifie un intrant (nom, catégorie, seuil) sans jamais toucher au stock', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg', quantite_initiale: 50 })
        ).body;

        const res = await request(app)
            .put(`/api/intrants/${intrant.id}`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ nom: 'Aliment ponte', seuil_alerte: 10 });
        expect(res.status).toBe(200);
        expect(res.body.nom).toBe('Aliment ponte');
        expect(Number(res.body.quantite_stock)).toBe(50);
    });

    test('supprime (soft delete) un intrant — réservé à un admin', async () => {
        const intrant = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`).send({ nom: 'Aliment', unite: 'kg' })
        ).body;

        const refuse = await request(app).delete(`/api/intrants/${intrant.id}`).set('Authorization', `Bearer ${tokenChefProd}`);
        expect(refuse.status).toBe(403);

        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await request(app).delete(`/api/intrants/${intrant.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(204);

        const liste = await request(app).get('/api/intrants').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(liste.body).toHaveLength(0);
    });

    test('un livreur ne peut pas accéder au module intrants', async () => {
        const tokenLivreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId });
        const res = await request(app).get('/api/intrants').set('Authorization', `Bearer ${tokenLivreur}`);
        expect(res.status).toBe(403);
    });

    test("un intrant d'une autre organisation n'apparaît jamais dans la liste (isolation)", async () => {
        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const autreToken = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: autreTenantId });
        await request(app).post('/api/intrants').set('Authorization', `Bearer ${autreToken}`).send({ nom: 'Intrant Autre Ferme', unite: 'kg' });

        const res = await request(app).get('/api/intrants').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(res.body.find((i) => i.nom === 'Intrant Autre Ferme')).toBeUndefined();
    });

    test("une entrée sur un intrant d'une autre organisation échoue (404)", async () => {
        const autreTenantId = await creerOrganisation(pool, 'Autre Ferme');
        const autreToken = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: autreTenantId });
        const intrantAutreFerme = (
            await request(app).post('/api/intrants').set('Authorization', `Bearer ${autreToken}`).send({ nom: 'Aliment', unite: 'kg' })
        ).body;

        const res = await request(app).post(`/api/intrants/${intrantAutreFerme.id}/entree`).set('Authorization', `Bearer ${tokenChefProd}`).send({ quantite: 10 });
        expect(res.status).toBe(404);
    });
});

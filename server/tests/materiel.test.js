const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

async function creerEquipement(app, token, overrides = {}) {
    const res = await request(app)
        .post('/api/materiel')
        .set('Authorization', `Bearer ${token}`)
        .send({ nom: 'Motoculteur', categorie: 'Motoculture', ...overrides });
    return res.body;
}

describe('matériel — inventaire et entretien', () => {
    let pool;
    let app;
    let token;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['materiel', 'fournisseurs', 'comptabilite']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un équipement puis le liste', async () => {
        await creerEquipement(app, token, { nom: 'Pompe à eau' });

        const res = await request(app).get('/api/materiel').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].nom).toBe('Pompe à eau');
        expect(res.body[0].etat).toBe('Bon');
        expect(res.body[0].quantite).toBe(1);
    });

    test('rejette la création sans nom', async () => {
        const res = await request(app)
            .post('/api/materiel')
            .set('Authorization', `Bearer ${token}`)
            .send({ categorie: 'Autre' });
        expect(res.status).toBe(400);
    });

    test('modifie un équipement', async () => {
        const eq = await creerEquipement(app, token);
        const res = await request(app)
            .put(`/api/materiel/${eq.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ etat: 'A réparer' });
        expect(res.status).toBe(200);
        expect(res.body.etat).toBe('A réparer');
    });

    test('un rôle non autorisé (chef_prod) ne peut pas accéder au module', async () => {
        const tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId });
        const res = await request(app).get('/api/materiel').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(res.status).toBe(403);
    });

    test('supprime un équipement (admin uniquement)', async () => {
        const eq = await creerEquipement(app, token);
        const refuse = await request(app).delete(`/api/materiel/${eq.id}`).set('Authorization', `Bearer ${token}`);
        expect(refuse.status).toBe(403);

        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await request(app).delete(`/api/materiel/${eq.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(204);

        const liste = await request(app).get('/api/materiel').set('Authorization', `Bearer ${token}`);
        expect(liste.body).toHaveLength(0);
    });

    test('enregistre un entretien sans coût : historique mis à jour, pas de dépense créée', async () => {
        const eq = await creerEquipement(app, token);

        const res = await request(app)
            .post(`/api/materiel/${eq.id}/entretiens`)
            .set('Authorization', `Bearer ${token}`)
            .send({ date_entretien: '2026-08-21', description: 'Vidange' });
        expect(res.status).toBe(201);

        const historique = await request(app).get(`/api/materiel/${eq.id}/entretiens`).set('Authorization', `Bearer ${token}`);
        expect(historique.body).toHaveLength(1);
        expect(historique.body[0].description).toBe('Vidange');

        const depenses = await request(app).get('/api/comptabilite/depenses').set('Authorization', `Bearer ${token}`);
        expect(depenses.body).toHaveLength(0);
    });

    test('enregistre un entretien avec coût : génère une dépense catégorie Matériel et met à jour le prochain entretien', async () => {
        const eq = await creerEquipement(app, token);

        const res = await request(app)
            .post(`/api/materiel/${eq.id}/entretiens`)
            .set('Authorization', `Bearer ${token}`)
            .send({ date_entretien: '2026-08-21', description: 'Remplacement courroie', cout: 15000, prochain_entretien: '2026-11-21' });
        expect(res.status).toBe(201);

        const equipement = await request(app).get('/api/materiel').set('Authorization', `Bearer ${token}`);
        expect(equipement.body[0].prochain_entretien.slice(0, 10)).toBe('2026-11-21');

        const depenses = await request(app).get('/api/comptabilite/depenses').set('Authorization', `Bearer ${token}`);
        expect(depenses.body).toHaveLength(1);
        expect(depenses.body[0].categorie).toBe('Matériel');
        expect(Number(depenses.body[0].montant)).toBe(15000);
    });
});

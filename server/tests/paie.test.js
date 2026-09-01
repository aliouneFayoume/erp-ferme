const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

async function creerEmploye(app, token, overrides = {}) {
    const res = await request(app)
        .post('/api/paie/employes')
        .set('Authorization', `Bearer ${token}`)
        .send({ nom_complet: 'Awa Diagne', poste: 'Ouvrière agricole', salaire_brut_mensuel: 80000, ...overrides });
    return res.body;
}

describe('paie — employés et bulletins', () => {
    let pool;
    let app;
    let token;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['paie', 'comptabilite']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un employé puis le liste', async () => {
        await creerEmploye(app, token, { nom_complet: 'Moussa Fall' });

        const res = await request(app).get('/api/paie/employes').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].nom_complet).toBe('Moussa Fall');
        expect(res.body[0].actif).toBe(true);
    });

    test('rejette la création sans nom', async () => {
        const res = await request(app).post('/api/paie/employes').set('Authorization', `Bearer ${token}`).send({ poste: 'Ouvrier' });
        expect(res.status).toBe(400);
    });

    test('un rôle non autorisé (chef_prod) ne peut pas accéder au module paie', async () => {
        const tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId });
        const res = await request(app).get('/api/paie/employes').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(res.status).toBe(403);
    });

    test('crée un bulletin de paie EN_ATTENTE avec salaire net calculé', async () => {
        const emp = await creerEmploye(app, token);

        const res = await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-01', salaire_brut: 80000, charges_sociales: 8000 });
        expect(res.status).toBe(201);
        expect(res.body.statut).toBe('EN_ATTENTE');
        expect(Number(res.body.salaire_net)).toBe(72000);
    });

    test('rejette un doublon de bulletin sur la même période pour le même employé', async () => {
        const emp = await creerEmploye(app, token);
        await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-01', salaire_brut: 80000, charges_sociales: 8000 });

        const doublon = await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-15', salaire_brut: 80000, charges_sociales: 8000 });
        expect(doublon.status).toBe(409);
    });

    test('marquer payé pose une dépense "Main d\'œuvre" pour brut + charges (pas le net)', async () => {
        const emp = await creerEmploye(app, token);
        const bulletin = await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-01', salaire_brut: 80000, charges_sociales: 8000 });

        const res = await request(app).put(`/api/paie/bulletins/${bulletin.body.id}/payer`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.statut).toBe('PAYE');

        const depenses = await request(app).get('/api/comptabilite/depenses').set('Authorization', `Bearer ${token}`);
        expect(depenses.body).toHaveLength(1);
        expect(depenses.body[0].categorie).toBe("Main d'œuvre");
        expect(Number(depenses.body[0].montant)).toBe(88000);
    });

    test('un bulletin déjà payé ne peut pas être repayé', async () => {
        const emp = await creerEmploye(app, token);
        const bulletin = await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-01', salaire_brut: 80000, charges_sociales: 8000 });
        await request(app).put(`/api/paie/bulletins/${bulletin.body.id}/payer`).set('Authorization', `Bearer ${token}`);

        const deuxieme = await request(app).put(`/api/paie/bulletins/${bulletin.body.id}/payer`).set('Authorization', `Bearer ${token}`);
        expect(deuxieme.status).toBe(400);
    });

    test('filtre les bulletins par période', async () => {
        const emp = await creerEmploye(app, token);
        await request(app)
            .post('/api/paie/bulletins')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, periode: '2026-09-01', salaire_brut: 80000, charges_sociales: 8000 });

        const septembre = await request(app).get('/api/paie/bulletins?periode=2026-09').set('Authorization', `Bearer ${token}`);
        expect(septembre.body).toHaveLength(1);

        const octobre = await request(app).get('/api/paie/bulletins?periode=2026-10').set('Authorization', `Bearer ${token}`);
        expect(octobre.body).toHaveLength(0);
    });

    test('supprime un employé (admin uniquement)', async () => {
        const emp = await creerEmploye(app, token);
        const refuse = await request(app).delete(`/api/paie/employes/${emp.id}`).set('Authorization', `Bearer ${token}`);
        expect(refuse.status).toBe(403);

        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await request(app).delete(`/api/paie/employes/${emp.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(204);

        const liste = await request(app).get('/api/paie/employes').set('Authorization', `Bearer ${token}`);
        expect(liste.body).toHaveLength(0);
    });
});

describe('paie — journaliers et pointages', () => {
    let pool;
    let app;
    let token;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        app = buildApp(pool, ['paie', 'comptabilite']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    async function creerJournalier(overrides = {}) {
        const res = await request(app)
            .post('/api/paie/employes')
            .set('Authorization', `Bearer ${token}`)
            .send({ nom_complet: 'Ibrahima Ba', type_contrat: 'JOURNALIER', taux_journalier: 2000, ...overrides });
        return res.body;
    }

    test('un employé créé sans type_contrat reste MENSUEL par défaut', async () => {
        const emp = await creerEmploye(app, token);
        expect(emp.type_contrat).toBe('MENSUEL');
    });

    test('rejette un journalier sans taux_journalier', async () => {
        const res = await request(app)
            .post('/api/paie/employes')
            .set('Authorization', `Bearer ${token}`)
            .send({ nom_complet: 'Ibrahima Ba', type_contrat: 'JOURNALIER' });
        expect(res.status).toBe(400);
    });

    test('crée un journalier avec son taux', async () => {
        const emp = await creerJournalier();
        expect(emp.type_contrat).toBe('JOURNALIER');
        expect(Number(emp.taux_journalier)).toBe(2000);
    });

    test('un journalier n\'apparaît pas encore pointé', async () => {
        await creerJournalier();
        const res = await request(app).get('/api/paie/pointages?date=2026-09-05').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].pointe).toBe(false);
    });

    test('basculer le pointage marque présent puis absent', async () => {
        const emp = await creerJournalier();

        const present = await request(app)
            .post('/api/paie/pointages/toggle')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, date: '2026-09-05' });
        expect(present.status).toBe(200);
        expect(present.body.pointe).toBe(true);

        const absent = await request(app)
            .post('/api/paie/pointages/toggle')
            .set('Authorization', `Bearer ${token}`)
            .send({ employe_id: emp.id, date: '2026-09-05' });
        expect(absent.body.pointe).toBe(false);
    });

    test('le récapitulatif compte les jours du mois demandé et exclut les autres mois', async () => {
        const emp = await creerJournalier();
        for (const date of ['2026-09-01', '2026-09-05', '2026-10-01']) {
            await request(app)
                .post('/api/paie/pointages/toggle')
                .set('Authorization', `Bearer ${token}`)
                .send({ employe_id: emp.id, date });
        }

        const septembre = await request(app).get('/api/paie/pointages/recapitulatif?periode=2026-09').set('Authorization', `Bearer ${token}`);
        expect(septembre.body).toEqual([{ employe_id: emp.id, jours_travailles: 2 }]);

        const octobre = await request(app).get('/api/paie/pointages/recapitulatif?periode=2026-10').set('Authorization', `Bearer ${token}`);
        expect(octobre.body).toEqual([{ employe_id: emp.id, jours_travailles: 1 }]);
    });

    test('un rôle non autorisé (chef_prod) ne peut pas accéder aux pointages', async () => {
        const tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId });
        const res = await request(app).get('/api/paie/pointages?date=2026-09-05').set('Authorization', `Bearer ${tokenChefProd}`);
        expect(res.status).toBe(403);
    });
});

// Limites pg-mem connues (voir aussi inscription.test.js) :
// - RLS/CREATE POLICY est unparseable sous pg-mem : ces tests exercent uniquement le filtrage
//   applicatif (tenant_id/secteur_id dans les routes) — la RLS réelle des tables animaux/
//   reproductions/releves_animal est vérifiée séparément en prod (psql).
// - ROLLBACK ne défait pas réellement les écritures déjà faites sous pg-mem : le test d'atomicité
//   de la mise-bas n'affirme donc PAS l'absence des lignes partiellement insérées, seulement le
//   code HTTP et l'état de la reproduction elle-même (mise à jour après coup, jamais atteinte).
const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

async function creerSecteurElevage(pool, tenantId) {
    const elevage = await pool.query(
        `INSERT INTO secteurs (tenant_id, nom, suivi_individuel) VALUES ($1, 'Élevage', FALSE) RETURNING id`,
        [tenantId]
    );
    const bovins = await pool.query(
        `INSERT INTO secteurs (tenant_id, nom, parent_secteur_id, suivi_individuel) VALUES ($1, 'Bovins', $2, TRUE) RETURNING id`,
        [tenantId, elevage.rows[0].id]
    );
    return { elevageId: elevage.rows[0].id, secteurId: bovins.rows[0].id };
}

async function creerAnimal(app, token, secteurId, overrides = {}) {
    const res = await request(app)
        .post('/api/elevage/animaux')
        .set('Authorization', `Bearer ${token}`)
        .send({ secteur_id: secteurId, identifiant: `BOV-${Date.now()}-${Math.floor(Math.random() * 10000)}`, espece: 'BOVIN', sexe: 'F', ...overrides });
    return res.body;
}

describe('elevage — animaux et reproduction', () => {
    let pool;
    let app;
    let token;
    let tenantId;
    let secteurId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        ({ secteurId } = await creerSecteurElevage(pool, tenantId));
        app = buildApp(pool, ['elevage']);
        token = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId, secteur_id: secteurId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un animal puis le liste', async () => {
        await creerAnimal(app, token, secteurId, { identifiant: 'BOV-001' });

        const res = await request(app).get('/api/elevage/animaux').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].identifiant).toBe('BOV-001');
        expect(res.body[0].statut).toBe('VIVANT');
    });

    test('filtre les animaux par espèce', async () => {
        await creerAnimal(app, token, secteurId, { identifiant: 'BOV-A', espece: 'BOVIN' });
        await creerAnimal(app, token, secteurId, { identifiant: 'BOV-B', espece: 'OVIN' });

        const res = await request(app).get('/api/elevage/animaux?espece=OVIN').set('Authorization', `Bearer ${token}`);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].identifiant).toBe('BOV-B');
    });

    test('rejette la création directement sous le secteur parent "Élevage"', async () => {
        const { elevageId } = await creerSecteurElevage(pool, tenantId);
        // Un chef_prod scopé à un sous-secteur (bovins) ne peut de toute façon pas cibler un autre
        // secteur ; on teste ici avec un admin pour isoler la validation "pas de suivi_individuel".
        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await request(app)
            .post('/api/elevage/animaux')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ secteur_id: elevageId, identifiant: 'BOV-X', espece: 'BOVIN', sexe: 'F' });
        expect(res.status).toBe(400);
    });

    test('rejette une espèce ou un sexe invalide', async () => {
        const resEspece = await request(app)
            .post('/api/elevage/animaux')
            .set('Authorization', `Bearer ${token}`)
            .send({ secteur_id: secteurId, identifiant: 'BOV-X', espece: 'PORCIN', sexe: 'F' });
        expect(resEspece.status).toBe(400);

        const resSexe = await request(app)
            .post('/api/elevage/animaux')
            .set('Authorization', `Bearer ${token}`)
            .send({ secteur_id: secteurId, identifiant: 'BOV-Y', espece: 'BOVIN', sexe: 'X' });
        expect(resSexe.status).toBe(400);
    });

    test('isolation tenant : un animal du tenant A est invisible au tenant B', async () => {
        const animal = await creerAnimal(app, token, secteurId);

        const tenantB = await creerOrganisation(pool, 'Autre Ferme');
        const { secteurId: secteurB } = await creerSecteurElevage(pool, tenantB);
        const tokenB = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantB, secteur_id: secteurB });

        const res = await request(app).get(`/api/elevage/animaux/${animal.id}`).set('Authorization', `Bearer ${tokenB}`);
        expect(res.status).toBe(403);
    });

    test('un chef_prod d\'un autre secteur ne peut pas voir un animal Bovins', async () => {
        const animal = await creerAnimal(app, token, secteurId);
        const tokenAutreSecteur = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId, secteur_id: 1 });

        const res = await request(app).get(`/api/elevage/animaux/${animal.id}`).set('Authorization', `Bearer ${tokenAutreSecteur}`);
        expect(res.status).toBe(403);
    });

    test('transitions de statut : succès puis rejet sur un animal déjà sorti', async () => {
        const animal = await creerAnimal(app, token, secteurId);

        const vendu = await request(app)
            .put(`/api/elevage/animaux/${animal.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'VENDU' });
        expect(vendu.status).toBe(200);
        expect(vendu.body.statut).toBe('VENDU');
        expect(vendu.body.date_sortie).toBeTruthy();

        const rejoue = await request(app)
            .put(`/api/elevage/animaux/${animal.id}/statut`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'ABATTU' });
        expect(rejoue.status).toBe(400);
    });

    test('relevé PESEE sans poids rejeté ; relevé valide récupérable', async () => {
        const animal = await creerAnimal(app, token, secteurId);

        const sansPoids = await request(app)
            .post(`/api/elevage/animaux/${animal.id}/releves`)
            .set('Authorization', `Bearer ${token}`)
            .send({ date_releve: '2026-08-25', type_evenement: 'PESEE' });
        expect(sansPoids.status).toBe(400);

        const avecPoids = await request(app)
            .post(`/api/elevage/animaux/${animal.id}/releves`)
            .set('Authorization', `Bearer ${token}`)
            .send({ date_releve: '2026-08-25', type_evenement: 'PESEE', poids_kg: 120 });
        expect(avecPoids.status).toBe(201);

        const liste = await request(app).get(`/api/elevage/animaux/${animal.id}/releves`).set('Authorization', `Bearer ${token}`);
        expect(liste.body).toHaveLength(1);
        expect(Number(liste.body[0].poids_kg)).toBe(120);
    });

    test('suppression : admin seul, chef_prod refusé', async () => {
        const animal = await creerAnimal(app, token, secteurId);

        const refuse = await request(app).delete(`/api/elevage/animaux/${animal.id}`).set('Authorization', `Bearer ${token}`);
        expect(refuse.status).toBe(403);

        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await request(app).delete(`/api/elevage/animaux/${animal.id}`).set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(204);

        const liste = await request(app).get('/api/elevage/animaux').set('Authorization', `Bearer ${token}`);
        expect(liste.body).toHaveLength(0);
    });

    describe('reproduction', () => {
        test('rejette une saillie sur un mâle ou un animal non vivant', async () => {
            const male = await creerAnimal(app, token, secteurId, { sexe: 'M' });
            const resMale = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: male.id, date_saillie: '2026-08-01' });
            expect(resMale.status).toBe(400);

            const morte = await creerAnimal(app, token, secteurId, { sexe: 'F' });
            await request(app).put(`/api/elevage/animaux/${morte.id}/statut`).set('Authorization', `Bearer ${token}`).send({ statut: 'MORT' });
            const resMorte = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: morte.id, date_saillie: '2026-08-01' });
            expect(resMorte.status).toBe(400);
        });

        test('rejette une 2e gestation EN_COURS concurrente sur la même mère', async () => {
            const mere = await creerAnimal(app, token, secteurId, { sexe: 'F' });
            const premiere = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: mere.id, date_saillie: '2026-08-01' });
            expect(premiere.status).toBe(201);

            const deuxieme = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: mere.id, date_saillie: '2026-08-15' });
            expect(deuxieme.status).toBe(409);
        });

        test('mise-bas atomique : N petits créés avec le bon mere_id/reproduction_id', async () => {
            const mere = await creerAnimal(app, token, secteurId, { sexe: 'F', identifiant: 'BOV-MERE' });
            const repro = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: mere.id, date_saillie: '2026-05-01' });

            const res = await request(app)
                .put(`/api/elevage/reproductions/${repro.body.id}/mise-bas`)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    date_mise_bas_reelle: '2026-08-10',
                    petits: [
                        { identifiant: 'BOV-PETIT-1', sexe: 'F', poids_initial_kg: 30 },
                        { identifiant: 'BOV-PETIT-2', sexe: 'M', poids_initial_kg: 32 },
                        { identifiant: 'BOV-PETIT-3', sexe: 'F', poids_initial_kg: 28 },
                    ],
                });
            expect(res.status).toBe(200);
            expect(res.body.statut).toBe('MISE_BAS');
            expect(res.body.nombre_petits).toBe(3);

            const liste = await request(app).get(`/api/elevage/animaux?mere_id=${mere.id}`).set('Authorization', `Bearer ${token}`);
            expect(liste.body).toHaveLength(3);
            expect(liste.body.every((p) => p.reproduction_id === repro.body.id)).toBe(true);

            const rejoue = await request(app)
                .put(`/api/elevage/reproductions/${repro.body.id}/mise-bas`)
                .set('Authorization', `Bearer ${token}`)
                .send({ date_mise_bas_reelle: '2026-08-11', petits: [{ identifiant: 'BOV-PETIT-4', sexe: 'F' }] });
            expect(rejoue.status).toBe(400);
        });

        test('mise-bas : un identifiant en doublon fait échouer la portée (409), la gestation reste EN_COURS', async () => {
            const mere = await creerAnimal(app, token, secteurId, { sexe: 'F' });
            await creerAnimal(app, token, secteurId, { identifiant: 'BOV-DEJA-PRIS', sexe: 'M' });
            const repro = await request(app)
                .post('/api/elevage/reproductions')
                .set('Authorization', `Bearer ${token}`)
                .send({ mere_id: mere.id, date_saillie: '2026-05-01' });

            const res = await request(app)
                .put(`/api/elevage/reproductions/${repro.body.id}/mise-bas`)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    date_mise_bas_reelle: '2026-08-10',
                    petits: [
                        { identifiant: 'BOV-OK', sexe: 'F' },
                        { identifiant: 'BOV-DEJA-PRIS', sexe: 'M' }, // doublon (déjà pris par un autre animal du tenant)
                    ],
                });
            expect(res.status).toBe(409);

            // Note : on ne vérifie pas ici l'absence de "BOV-OK" malgré le ROLLBACK — pg-mem ne
            // simule pas réellement l'annulation transactionnelle (BEGIN/COMMIT/ROLLBACK sont
            // acceptés syntaxiquement mais un ROLLBACK ne défait pas les écritures déjà faites),
            // contrairement à un vrai PostgreSQL — même limite déjà documentée pour
            // routes/inscription.js. L'atomicité réelle n'est vérifiable que manuellement.
            // Ce qui reste vérifiable ici : la reproduction elle-même n'a jamais été mise à jour
            // (l'UPDATE arrive après la boucle d'insertion des petits, donc n'a jamais tourné).
            const reproInchangee = await request(app).get(`/api/elevage/reproductions?mere_id=${mere.id}`).set('Authorization', `Bearer ${token}`);
            expect(reproInchangee.body[0].statut).toBe('EN_COURS');
        });
    });
});

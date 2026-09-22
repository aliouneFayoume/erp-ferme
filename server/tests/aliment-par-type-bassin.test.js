const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Ferme piscicole à sous-secteurs (cas Fish Feed Burkina) : Piscicole > Éclosion / Élevage larvaire /
// Pregrossissement. Trois types de bassin, trois aliments utilisés le même jour : chaque relevé doit
// déduire l'aliment DE SON type de bassin, jamais celui d'un autre.
describe('intrants — un aliment par type de bassin (sous-secteurs)', () => {
    let pool;
    let app;
    let tenantId;
    let token;
    let piscicole;
    let eclosion;
    let larvaire;
    let pregrossissement;

    const creerSecteur = async (nom, parentId = null) =>
        (await pool.query(`INSERT INTO secteurs (tenant_id, nom, parent_secteur_id) VALUES ($1, $2, $3) RETURNING id`, [tenantId, nom, parentId])).rows[0].id;

    const creerAliment = async (nom, stock = 100) =>
        (
            await pool.query(
                `INSERT INTO intrants (tenant_id, nom, categorie, unite, quantite_stock) VALUES ($1, $2, 'Aliment', 'kg', $3) RETURNING id`,
                [tenantId, nom, stock]
            )
        ).rows[0].id;

    const creerLot = async (secteurId, code) =>
        (
            await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
                 VALUES ($1, $2, $3, 1, '2026-09-14', 'EN_COURS') RETURNING id`,
                [tenantId, secteurId, code]
            )
        ).rows[0].id;

    const lierAliment = (secteurId, intrantId) =>
        request(app).put(`/api/production/secteurs/${secteurId}/aliment-defaut`).set('Authorization', `Bearer ${token}`).send({ intrant_id: intrantId });

    const stock = async (intrantId) => Number((await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [intrantId])).rows[0].quantite_stock);

    const sync = (releves) => request(app).post('/api/production/sync').set('Authorization', `Bearer ${token}`).send({ releves });

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        piscicole = await creerSecteur('Piscicole Test');
        eclosion = await creerSecteur('Éclosion', piscicole);
        larvaire = await creerSecteur('Élevage larvaire', piscicole);
        pregrossissement = await creerSecteur('Pregrossissement', piscicole);
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['production', 'intrants']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('3 types de bassin, 3 aliments : un même envoi de relevés déduit chaque aliment de son propre stock', async () => {
        const demarrage = await creerAliment('Aliment démarrage', 100);
        const larvaireAliment = await creerAliment('Aliment larvaire', 200);
        const pregrossissementAliment = await creerAliment('Aliment prégrossissement', 300);
        await lierAliment(eclosion, demarrage);
        await lierAliment(larvaire, larvaireAliment);
        await lierAliment(pregrossissement, pregrossissementAliment);
        const lotEclosion = await creerLot(eclosion, 'ECL-01');
        const lotLarvaire = await creerLot(larvaire, 'LAR-01');
        const lotPre = await creerLot(pregrossissement, 'PRE-01');

        const res = await sync([
            { lot_id: lotEclosion, date_releve: '2026-09-22', conso_aliment_kg: 2 },
            { lot_id: lotLarvaire, date_releve: '2026-09-22', conso_aliment_kg: 5 },
            { lot_id: lotPre, date_releve: '2026-09-22', conso_aliment_kg: 12 },
        ]);

        expect(res.status).toBe(200);
        expect(await stock(demarrage)).toBe(98);
        expect(await stock(larvaireAliment)).toBe(195);
        expect(await stock(pregrossissementAliment)).toBe(288);
    });

    test("un type de bassin sans aliment propre reprend celui de son secteur parent", async () => {
        const aliment = await creerAliment('Aliment commun', 50);
        await lierAliment(piscicole, aliment); // réglage de repli sur le parent
        const lot = await creerLot(larvaire, 'LAR-02');

        await sync([{ lot_id: lot, date_releve: '2026-09-22', conso_aliment_kg: 4 }]);

        expect(await stock(aliment)).toBe(46);
    });

    test("l'aliment propre au type de bassin prime sur celui du parent, qui reste intact", async () => {
        const parent = await creerAliment('Aliment parent', 50);
        const propre = await creerAliment('Aliment larvaire propre', 50);
        await lierAliment(piscicole, parent);
        await lierAliment(larvaire, propre);
        const lot = await creerLot(larvaire, 'LAR-03');

        await sync([{ lot_id: lot, date_releve: '2026-09-22', conso_aliment_kg: 3 }]);

        expect(await stock(propre)).toBe(47);
        expect(await stock(parent)).toBe(50);
    });

    test("sans aliment sur le type de bassin ni sur le parent, aucun stock n'est touché", async () => {
        const aliment = await creerAliment('Aliment non lié', 50);
        const lot = await creerLot(eclosion, 'ECL-02');

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-22', conso_aliment_kg: 6 }]);

        expect(res.status).toBe(200);
        expect(await stock(aliment)).toBe(50);
    });

    test("le réglage d'un type de bassin n'affecte jamais ses voisins", async () => {
        const demarrage = await creerAliment('Aliment démarrage', 100);
        await lierAliment(eclosion, demarrage);
        const lotLarvaire = await creerLot(larvaire, 'LAR-04'); // aucun aliment configuré ici

        await sync([{ lot_id: lotLarvaire, date_releve: '2026-09-22', conso_aliment_kg: 9 }]);

        expect(await stock(demarrage)).toBe(100);
    });

    test("l'historique d'un aliment indique le bassin et son type de bassin", async () => {
        const demarrage = await creerAliment('Aliment démarrage', 100);
        await lierAliment(eclosion, demarrage);
        const lot = await creerLot(eclosion, 'ECL-03');
        await sync([{ lot_id: lot, date_releve: '2026-09-22', conso_aliment_kg: 2 }]);

        const res = await request(app).get(`/api/intrants/${demarrage}/mouvements`).set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].code_lot).toBe('ECL-03');
        expect(res.body[0].secteur_nom).toBe('Éclosion');
    });

    test("GET /production/secteurs expose l'aliment lié à chaque sous-secteur (pour l'écran Intrants)", async () => {
        const demarrage = await creerAliment('Aliment démarrage', 100);
        await lierAliment(eclosion, demarrage);

        const res = await request(app).get('/api/production/secteurs').set('Authorization', `Bearer ${token}`);

        const ligneEclosion = res.body.find((s) => s.id === eclosion);
        expect(ligneEclosion.parent_secteur_id).toBe(piscicole);
        expect(ligneEclosion.intrant_alimentation_id).toBe(demarrage);
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// La mortalité saisie dans un relevé journalier est déduite de l'effectif du bassin (« effectif actuel »).
// Ce comportement existait sans aucun test. Verrouillé ici, avec deux protections : un effectif jamais négatif, et des
// nombres d'éléments (mortalité, œufs — colonnes INT) toujours ramenés à des entiers pour ne pas faire échouer le relevé.
describe('relevés — mortalité déduite de l’effectif', () => {
    let pool;
    let app;
    let tenantId;
    let token;
    let secteur;

    const creerLot = async (code, effectif = 1000) =>
        (
            await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
                 VALUES ($1, $2, $3, $4, '2026-09-14', 'EN_COURS') RETURNING id`,
                [tenantId, secteur, code, effectif]
            )
        ).rows[0].id;

    const sync = (releves, tokenUtilise = token) => request(app).post('/api/production/sync').set('Authorization', `Bearer ${tokenUtilise}`).send({ releves });
    const effectif = async (id) => Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [id])).rows[0].quantite_initiale);
    const releves = async (lotId) => (await pool.query(`SELECT * FROM releves_journaliers WHERE lot_id = $1 ORDER BY id`, [lotId])).rows;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        secteur = (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Piscicole Test') RETURNING id`, [tenantId])).rows[0].id;
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('la mortalité du relevé est déduite de l’effectif du bassin', async () => {
        const lot = await creerLot('ECL-01', 1000);

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-26', mortalite: 37 }]);

        expect(res.status).toBe(200);
        expect(await effectif(lot)).toBe(963);
        expect(Number((await releves(lot))[0].mortalite)).toBe(37);
    });

    test('les mortalités de plusieurs relevés s’additionnent, y compris dans un même envoi', async () => {
        const lot = await creerLot('ECL-01', 1000);

        await sync([
            { lot_id: lot, date_releve: '2026-09-25', mortalite: 10 },
            { lot_id: lot, date_releve: '2026-09-26', mortalite: 25 },
        ]);
        await sync([{ lot_id: lot, date_releve: '2026-09-27', mortalite: 5 }]);

        expect(await effectif(lot)).toBe(960);
    });

    test('une mortalité nulle ou absente ne change pas l’effectif', async () => {
        const lot = await creerLot('ECL-01', 1000);

        await sync([{ lot_id: lot, date_releve: '2026-09-26', mortalite: 0 }, { lot_id: lot, date_releve: '2026-09-27' }]);

        expect(await effectif(lot)).toBe(1000);
    });

    test('une mortalité supérieure à l’effectif (faute de frappe) laisse un effectif à 0, jamais négatif, et le relevé est enregistré', async () => {
        const lot = await creerLot('ECL-01', 50);

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-26', mortalite: 500 }]);

        expect(res.status).toBe(200);
        expect(await effectif(lot)).toBe(0);
        expect(await releves(lot)).toHaveLength(1);
    });

    test('une mortalité décimale ne fait pas échouer l’envoi : arrondie à l’entier', async () => {
        const lot = await creerLot('ECL-01', 1000);

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-26', mortalite: 2.4 }]);

        expect(res.status).toBe(200);
        expect(await effectif(lot)).toBe(998);
        expect(Number((await releves(lot))[0].mortalite)).toBe(2);
    });

    test('une mortalité négative est ignorée (jamais de poissons « ressuscités »)', async () => {
        const lot = await creerLot('ECL-01', 1000);

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-26', mortalite: -40 }]);

        expect(res.status).toBe(200);
        expect(await effectif(lot)).toBe(1000);
    });

    test('un nombre d’œufs décimal est ramené à un entier (colonne INT) sans faire échouer le relevé', async () => {
        const lot = await creerLot('POU-01', 200);

        const res = await sync([{ lot_id: lot, date_releve: '2026-09-26', oeufs_collectes: 12.4 }]);

        expect(res.status).toBe(200);
        expect(Number((await releves(lot))[0].oeufs_collectes)).toBe(12);
    });

    test('un relevé sur un bassin d’une autre ferme est refusé et ne touche aucun effectif', async () => {
        const autre = await creerOrganisation(pool, 'Autre Ferme');
        const secteurAutre = (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Piscicole Autre') RETURNING id`, [autre])).rows[0].id;
        const etranger = (
            await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
                 VALUES ($1, $2, 'ETR-01', 300, '2026-09-14', 'EN_COURS') RETURNING id`,
                [autre, secteurAutre]
            )
        ).rows[0].id;

        const res = await sync([{ lot_id: etranger, date_releve: '2026-09-26', mortalite: 50 }]);

        expect(res.status).toBe(403);
        expect(await effectif(etranger)).toBe(300);
    });

    test('la mortalité et le déplacement de poissons se combinent : l’effectif reste cohérent', async () => {
        const depart = await creerLot('ECL-05', 1000);
        const arrivee = await creerLot('LAR-03', 0);
        await sync([{ lot_id: depart, date_releve: '2026-09-26', mortalite: 40 }]);

        const dep = await request(app)
            .post('/api/production/mouvements')
            .set('Authorization', `Bearer ${token}`)
            .send({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 500, date_mouvement: '2026-09-26' });
        await sync([{ lot_id: arrivee, date_releve: '2026-09-27', mortalite: 20 }]);

        expect(dep.status).toBe(201);
        expect(await effectif(depart)).toBe(460); // 1000 - 40 - 500
        expect(await effectif(arrivee)).toBe(480); // 500 - 20
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Constat 2026-09-25 : un envoi de relevés rejoué (réponse perdue puis file hors ligne, ou formulaire renvoyé) était
// enregistré DEUX fois — mortalité, aliment et œufs comptés en double. Chaque relevé porte maintenant un identifiant
// unique créé par le navigateur ; le serveur ignore un relevé déjà reçu pour ce bassin.
describe('relevés — envoi rejoué sans doublon (client_id)', () => {
    let pool;
    let app;
    let tenantId;
    let token;
    let secteur;
    let aliment;

    const creerLot = async (code, effectif = 1000) =>
        (
            await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
                 VALUES ($1, $2, $3, $4, '2026-09-14', 'EN_COURS') RETURNING id`,
                [tenantId, secteur, code, effectif]
            )
        ).rows[0].id;

    const sync = (releves) => request(app).post('/api/production/sync').set('Authorization', `Bearer ${token}`).send({ releves });
    const effectif = async (id) => Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [id])).rows[0].quantite_initiale);
    const stockAliment = async () => Number((await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [aliment])).rows[0].quantite_stock);
    const nbReleves = async (lotId) => (await pool.query(`SELECT COUNT(*) AS n FROM releves_journaliers WHERE lot_id = $1`, [lotId])).rows[0].n;
    const nbMouvementsAliment = async () => Number((await pool.query(`SELECT COUNT(*) AS n FROM mouvements_intrants WHERE intrant_id = $1`, [aliment])).rows[0].n);

    const releve = (lotId, surcharges = {}) => ({ lot_id: lotId, date_releve: '2026-09-26', mortalite: 10, conso_aliment_kg: 2, ...surcharges });

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        aliment = (
            await pool.query(`INSERT INTO intrants (tenant_id, nom, categorie, unite, quantite_stock) VALUES ($1, 'Aliment', 'Aliment', 'kg', 100) RETURNING id`, [tenantId])
        ).rows[0].id;
        secteur = (await pool.query(`INSERT INTO secteurs (tenant_id, nom, intrant_alimentation_id) VALUES ($1, 'Piscicole Test', $2) RETURNING id`, [tenantId, aliment])).rows[0].id;
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('le même relevé renvoyé (même client_id) n’est compté qu’une fois : effectif, aliment et historique', async () => {
        const lot = await creerLot('ECL-01', 1000);
        const r = releve(lot, { client_id: 'a3f1c2d4-1111-4222-8333-444455556666' });

        const premier = await sync([r]);
        const rejeu = await sync([r]);

        expect(premier.status).toBe(200);
        expect(premier.body.doublons_ignores).toBe(0);
        expect(rejeu.status).toBe(200);
        expect(rejeu.body.doublons_ignores).toBe(1);
        expect(rejeu.body.message).toMatch(/déjà reçu/);
        expect(await effectif(lot)).toBe(990); // 1000 - 10, une seule fois
        expect(await stockAliment()).toBe(98); // 100 - 2, une seule fois
        expect(await nbReleves(lot)).toBe(1);
        expect(await nbMouvementsAliment()).toBe(1);
    });

    test('deux relevés VOLONTAIRES identiques mais avec des identifiants différents sont tous les deux enregistrés', async () => {
        const lot = await creerLot('ECL-01', 1000);

        await sync([releve(lot, { client_id: 'aaaaaaaa-0000-4000-8000-000000000001' })]);
        await sync([releve(lot, { client_id: 'aaaaaaaa-0000-4000-8000-000000000002' })]);

        expect(await nbReleves(lot)).toBe(2);
        expect(await effectif(lot)).toBe(980);
        expect(await stockAliment()).toBe(96);
    });

    test('sans client_id (ancienne version de l’application) : comportement inchangé, aucun blocage', async () => {
        const lot = await creerLot('ECL-01', 1000);

        await sync([releve(lot)]);
        await sync([releve(lot)]);

        expect(await nbReleves(lot)).toBe(2);
        expect(await effectif(lot)).toBe(980);
    });

    test('un identifiant mal formé est ignoré (pas de refus : la file hors ligne supprimerait le relevé)', async () => {
        const lot = await creerLot('ECL-01', 1000);

        const res = await sync([releve(lot, { client_id: 'court' }), releve(lot, { client_id: 'court' }), releve(lot, { client_id: 42 })]);

        expect(res.status).toBe(200);
        expect(await nbReleves(lot)).toBe(3);
    });

    test('le même identifiant deux fois dans UN SEUL envoi : le second est ignoré', async () => {
        const lot = await creerLot('ECL-01', 1000);
        const r = releve(lot, { client_id: 'bbbbbbbb-0000-4000-8000-000000000001' });

        const res = await sync([r, r]);

        expect(res.status).toBe(200);
        expect(res.body.doublons_ignores).toBe(1);
        expect(await effectif(lot)).toBe(990);
        expect(await nbReleves(lot)).toBe(1);
    });

    test('un même identifiant sur deux bassins DIFFÉRENTS n’est pas un doublon (unicité par bassin)', async () => {
        const a = await creerLot('ECL-01', 1000);
        const b = await creerLot('ECL-02', 1000);
        const id = 'cccccccc-0000-4000-8000-000000000001';

        await sync([releve(a, { client_id: id }), releve(b, { client_id: id })]);

        expect(await nbReleves(a)).toBe(1);
        expect(await nbReleves(b)).toBe(1);
    });

    test('un envoi mêlant un relevé déjà reçu et un nouveau ne garde que le nouveau', async () => {
        const lot = await creerLot('ECL-01', 1000);
        const ancien = releve(lot, { client_id: 'dddddddd-0000-4000-8000-000000000001', mortalite: 10, conso_aliment_kg: 2 });
        await sync([ancien]);

        const res = await sync([ancien, releve(lot, { client_id: 'dddddddd-0000-4000-8000-000000000002', mortalite: 5, conso_aliment_kg: 1 })]);

        expect(res.body.doublons_ignores).toBe(1);
        expect(await effectif(lot)).toBe(985); // 1000 - 10 - 5
        expect(await stockAliment()).toBe(97); // 100 - 2 - 1
        expect(await nbReleves(lot)).toBe(2);
    });

    test('un relevé rejoué ne recompte pas les œufs (plateaux) ', async () => {
        const produit = (await pool.query(`INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2c, prix_unitaire_b2b) VALUES ($1, $2, 'Œufs (plateau)', 'CAISSE', 3000, 2500) RETURNING id`, [tenantId, secteur])).rows[0].id;
        await pool.query(`INSERT INTO stocks (produit_id, quantite_disponible) VALUES ($1, 0)`, [produit]);
        await pool.query(`UPDATE secteurs SET produit_oeufs_id = $1, oeufs_par_plateau = 30 WHERE id = $2`, [produit, secteur]);
        const lot = await creerLot('POU-01', 200);
        const r = { lot_id: lot, date_releve: '2026-09-26', oeufs_collectes: 60, client_id: 'eeeeeeee-0000-4000-8000-000000000001' };

        await sync([r]);
        await sync([r]);

        const stock = (await pool.query(`SELECT quantite_disponible FROM stocks WHERE produit_id = $1`, [produit])).rows[0].quantite_disponible;
        expect(Number(stock)).toBe(2); // 60 œufs = 2 plateaux, une seule fois
    });
});

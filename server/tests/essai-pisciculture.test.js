const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

const TEL_POISSON = '+221771230001';
const TEL_POULET = '+221771230002';

describe('essai autonome — filière pisciculture (30 jours puis Pro, comme l’aviculture)', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai', 'production', 'auth']);
    });
    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    const dernierCode = () => {
        const appels = require('../src/whatsapp').envoyerMessageWhatsapp.mock.calls;
        return appels[appels.length - 1][1].composants[0].parameters[0].text;
    };
    async function ouvrir(telephone, filiere, nomFerme = 'Ferme du Test') {
        const corps = { nomFerme, telephone };
        if (filiere !== undefined) corps.filiere = filiere;
        expect((await request(app).post('/api/essai/inscription').send(corps)).status).toBe(202);
        const res = await request(app).post('/api/essai/verifier').send({ telephone, code: dernierCode() });
        expect(res.status).toBe(200);
        return res.body.token;
    }
    const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
    const tenantDe = async (telephone) => (await pool.query(`SELECT tenant_id FROM utilisateurs WHERE telephone = $1`, [telephone])).rows[0].tenant_id;

    test('« Pisciculture » crée un secteur Piscicole (pas d’Avicole) et un bassin de démo TERMINÉ de tilapia', async () => {
        await ouvrir(TEL_POISSON, 'piscicole');
        const tenant = await tenantDe(TEL_POISSON);

        const secteurs = (await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [tenant])).rows.map((s) => s.nom);
        expect(secteurs).toEqual(['Piscicole']);

        const lots = (await pool.query(`SELECT * FROM lots_production WHERE tenant_id = $1`, [tenant])).rows;
        expect(lots).toHaveLength(1);
        expect(lots[0]).toMatchObject({ code_lot: 'Bassin n°3 (démo)', statut: 'TERMINE', est_demo: true, espece: 'Tilapia' });
        // l'effectif du bassin est l'effectif ACTUEL : 3 000 alevins moins la mortalité des 120 jours
        const morts = (await pool.query(`SELECT SUM(mortalite)::int AS n, COUNT(*)::int AS jours FROM releves_journaliers WHERE lot_id = $1`, [lots[0].id])).rows[0];
        expect(morts.jours).toBe(120);
        expect(Number(lots[0].quantite_initiale)).toBe(3000 - morts.n);
        expect(morts.n).toBeGreaterThan(100);
        expect(morts.n).toBeLessThan(400); // survie réaliste (> 90 %)
    });

    test('les relevés portent les mesures d’un pisciculteur : pesées tous les 15 jours, taille, température et pH de l’eau', async () => {
        await ouvrir(TEL_POISSON, 'piscicole');
        const lotId = (await pool.query(`SELECT id FROM lots_production WHERE est_demo = TRUE`)).rows[0].id;
        const pesees = (await pool.query(`SELECT poids_moyen_g, taille_moyenne_cm FROM releves_journaliers WHERE lot_id = $1 AND poids_moyen_g > 0 ORDER BY date_releve`, [lotId])).rows;
        expect(pesees).toHaveLength(9);
        expect(Number(pesees[0].poids_moyen_g)).toBe(5);
        expect(Number(pesees[8].poids_moyen_g)).toBe(370);
        expect(Number(pesees[8].taille_moyenne_cm)).toBeGreaterThan(20);
        const eau = (await pool.query(`SELECT MIN(temperature_eau) AS tmin, MAX(temperature_eau) AS tmax, MIN(ph_eau) AS phmin, MAX(ph_eau) AS phmax FROM releves_journaliers WHERE lot_id = $1`, [lotId])).rows[0];
        expect(Number(eau.tmin)).toBeGreaterThanOrEqual(27);
        expect(Number(eau.tmax)).toBeLessThanOrEqual(30);
        expect(Number(eau.phmin)).toBeGreaterThanOrEqual(7);
        expect(Number(eau.phmax)).toBeLessThanOrEqual(8);
    });

    test('l’indice de consommation du bassin de démo est réaliste pour du tilapia (entre 1,2 et 2,0)', async () => {
        const token = await ouvrir(TEL_POISSON, 'piscicole');
        const lotId = (await pool.query(`SELECT id FROM lots_production WHERE est_demo = TRUE`)).rows[0].id;
        const res = await get(`/api/production/lots/${lotId}/fcr`, token);
        expect(res.status).toBe(200);
        expect(res.body.fcr).toBeGreaterThan(1.2);
        expect(res.body.fcr).toBeLessThan(2.0);
    });

    test('la récolte vendue de la démo : un produit « Tilapia frais (démo) » et deux livraisons, tous marqués démo', async () => {
        await ouvrir(TEL_POISSON, 'piscicole');
        const tenant = await tenantDe(TEL_POISSON);
        const produit = (await pool.query(`SELECT nom, unite_mesure, est_demo FROM produits WHERE tenant_id = $1`, [tenant])).rows;
        expect(produit).toEqual([{ nom: 'Tilapia frais (démo)', unite_mesure: 'KG', est_demo: true }]);
        const cmds = (await pool.query(`SELECT statut, est_demo FROM commandes WHERE tenant_id = $1`, [tenant])).rows;
        expect(cmds).toHaveLength(2);
        expect(cmds.every((c) => c.statut === 'LIVREE' && c.est_demo)).toBe(true);
    });

    test('même essai que l’aviculture : 30 jours, un seul lot suivi, un seul utilisateur, passage en Pro à la fin', async () => {
        const token = await ouvrir(TEL_POISSON, 'piscicole');
        const tenant = await tenantDe(TEL_POISSON);
        const ab = (await pool.query(`SELECT plan, essai_debut_le, essai_fin_le FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];
        expect(ab.plan).toBe('ESSAI');
        const jours = Math.round((new Date(ab.essai_fin_le) - new Date(ab.essai_debut_le)) / 86400000);
        expect(jours).toBe(30);

        const me = (await get('/api/auth/me', token)).body.utilisateur;
        expect(me.offre).toMatchObject({ plan: 'ESSAI' });

        // le gérant crée SON bassin réel (la démo est terminée : elle ne compte pas), puis un second est refusé (limite de l'essai)
        const secteur = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1`, [tenant])).rows[0].id;
        const bassin = (code) => request(app).post('/api/production/lots').set('Authorization', `Bearer ${token}`).send({ secteur_id: secteur, code_lot: code, quantite_initiale: 500, date_demarrage: '2026-10-19', espece: 'Tilapia' });
        expect((await bassin('B-1')).status).toBe(201);
        const second = await bassin('B-2');
        expect(second.status).toBe(402);
        expect(second.body.code).toBe('ESSAI_LIMITE_LOTS');
    });

    test('sans choix (ancienne page en cache) ou avec une valeur inconnue : aviculture, comme avant', async () => {
        await ouvrir(TEL_POULET, undefined, 'Ferme Poulets');
        const tenant = await tenantDe(TEL_POULET);
        expect((await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [tenant])).rows.map((s) => s.nom)).toEqual(['Avicole']);
        expect((await pool.query(`SELECT code_lot FROM lots_production WHERE tenant_id = $1`, [tenant])).rows[0].code_lot).toBe('Lot n°12 (démo)');

        await ouvrir('+221771230003', 'maraicher', 'Ferme Inconnue');
        const t2 = await tenantDe('+221771230003');
        expect((await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [t2])).rows.map((s) => s.nom)).toEqual(['Avicole']);
    });

    test('« Supprimer la démo » retire le bassin et ses ventes d’exemple, jamais les données réelles', async () => {
        const token = await ouvrir(TEL_POISSON, 'piscicole');
        const tenant = await tenantDe(TEL_POISSON);
        const secteur = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1`, [tenant])).rows[0].id;
        const reel = await request(app).post('/api/production/lots').set('Authorization', `Bearer ${token}`).send({ secteur_id: secteur, code_lot: 'B-REEL', quantite_initiale: 800, date_demarrage: '2026-10-19', espece: 'Tilapia' });
        expect(reel.status).toBe(201);

        const res = await request(app).delete('/api/essai/demo').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const restants = (await pool.query(`SELECT code_lot FROM lots_production WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenant])).rows;
        expect(restants.map((l) => l.code_lot)).toEqual(['B-REEL']);
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM produits WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenant])).rows[0].n).toBe(0);
    });
});

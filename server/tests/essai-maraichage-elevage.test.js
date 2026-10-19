const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

const TEL_MARAICHER = '+221771240001';
const TEL_ELEVEUR = '+221771240002';

describe('essai autonome — maraîchage et élevage (30 jours puis Pro, comme les autres filières)', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai', 'production', 'auth', 'elevage']);
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
        expect((await request(app).post('/api/essai/inscription').send({ nomFerme, telephone, filiere })).status).toBe(202);
        const res = await request(app).post('/api/essai/verifier').send({ telephone, code: dernierCode() });
        expect(res.status).toBe(200);
        return res.body.token;
    }
    const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
    const tenantDe = async (telephone) => (await pool.query(`SELECT tenant_id FROM utilisateurs WHERE telephone = $1`, [telephone])).rows[0].tenant_id;

    describe('maraîchage', () => {
        test('secteur « Maraîcher » (suivi de récolte) et parcelle de démo TERMINÉE : tomates, intrants, récolte, ventes', async () => {
            await ouvrir(TEL_MARAICHER, 'maraicher');
            const tenant = await tenantDe(TEL_MARAICHER);

            const secteurs = (await pool.query(`SELECT nom, suivi_recolte FROM secteurs WHERE tenant_id = $1`, [tenant])).rows;
            expect(secteurs).toEqual([{ nom: 'Maraîcher', suivi_recolte: true }]);

            const lot = (await pool.query(`SELECT * FROM lots_production WHERE tenant_id = $1`, [tenant])).rows[0];
            expect(lot).toMatchObject({ code_lot: 'Tomate — parcelle A (démo)', statut: 'TERMINE', est_demo: true, culture: 'Tomate', duree_maturite_jours: 75 });

            const releves = (await pool.query(`SELECT mortalite, intrants_utilises, quantite_recoltee_kg FROM releves_journaliers WHERE lot_id = $1`, [lot.id])).rows;
            const recolte = releves.reduce((s, r) => s + Number(r.quantite_recoltee_kg || 0), 0);
            expect(recolte).toBe(735);
            expect(releves.filter((r) => r.intrants_utilises).length).toBeGreaterThanOrEqual(4);
            // l'effectif est l'effectif ACTUEL : 400 plants moins ceux perdus
            const perdus = releves.reduce((s, r) => s + Number(r.mortalite || 0), 0);
            expect(Number(lot.quantite_initiale)).toBe(400 - perdus);

            // les ventes ne dépassent pas ce qui a été récolté
            const vendu = (await pool.query(`SELECT COALESCE(SUM(l.quantite), 0)::int AS kg FROM lignes_commande l WHERE l.lot_id = $1`, [lot.id])).rows[0].kg;
            expect(vendu).toBe(700);
            expect(vendu).toBeLessThanOrEqual(recolte);
        });

        test('même essai : 30 jours, une seule parcelle suivie, puis Pro', async () => {
            const token = await ouvrir(TEL_MARAICHER, 'maraicher');
            const tenant = await tenantDe(TEL_MARAICHER);
            const ab = (await pool.query(`SELECT plan, modules_actifs, essai_debut_le, essai_fin_le FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];
            expect(ab.plan).toBe('ESSAI');
            expect(Math.round((new Date(ab.essai_fin_le) - new Date(ab.essai_debut_le)) / 86400000)).toBe(30);
            expect(ab.modules_actifs).toEqual([]);

            const secteur = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1`, [tenant])).rows[0].id;
            const parcelle = (code) => request(app).post('/api/production/lots').set('Authorization', `Bearer ${token}`).send({ secteur_id: secteur, code_lot: code, quantite_initiale: 200, date_demarrage: '2026-10-19', culture: 'Oignon', duree_maturite_jours: 90 });
            expect((await parcelle('P-1')).status).toBe(201);
            expect((await parcelle('P-2')).status).toBe(402);
        });
    });

    describe('élevage', () => {
        test('secteur « Élevage » avec sous-secteurs Bovins/Ovins/Caprins (suivi individuel) et troupeau de démo', async () => {
            await ouvrir(TEL_ELEVEUR, 'elevage');
            const tenant = await tenantDe(TEL_ELEVEUR);

            const secteurs = (await pool.query(`SELECT s.nom, s.suivi_individuel, p.nom AS parent FROM secteurs s LEFT JOIN secteurs p ON p.id = s.parent_secteur_id WHERE s.tenant_id = $1 ORDER BY s.id`, [tenant])).rows;
            expect(secteurs).toEqual([
                { nom: 'Élevage', suivi_individuel: false, parent: null },
                { nom: 'Bovins', suivi_individuel: true, parent: 'Élevage' },
                { nom: 'Ovins', suivi_individuel: true, parent: 'Élevage' },
                { nom: 'Caprins', suivi_individuel: true, parent: 'Élevage' },
            ]);

            const animaux = (await pool.query(`SELECT a.identifiant, a.statut, a.est_demo, s.nom AS secteur FROM animaux a JOIN secteurs s ON s.id = a.secteur_id WHERE a.tenant_id = $1 ORDER BY a.id`, [tenant])).rows;
            expect(animaux).toHaveLength(7);
            expect(animaux.every((a) => a.est_demo && a.secteur === 'Bovins')).toBe(true);
            expect(animaux.filter((a) => a.statut === 'VENDU')).toHaveLength(1);
            // aucun lot : le troupeau n'entre pas dans la limite « 1 lot en cours »
            expect((await pool.query(`SELECT COUNT(*)::int AS n FROM lots_production WHERE tenant_id = $1`, [tenant])).rows[0].n).toBe(0);
        });

        test('pesées mensuelles avec une croissance cohérente, soins, et un veau né à la ferme de la vache BOV-D02', async () => {
            await ouvrir(TEL_ELEVEUR, 'elevage');
            const veau = (await pool.query(`SELECT a.id, m.identifiant AS mere FROM animaux a JOIN animaux m ON m.id = a.mere_id WHERE a.identifiant = 'BOV-D07'`)).rows[0];
            expect(veau.mere).toBe('BOV-D02');
            const pesees = (await pool.query(`SELECT poids_kg FROM releves_animal WHERE animal_id = $1 AND type_evenement = 'PESEE' ORDER BY date_releve`, [veau.id])).rows.map((r) => Number(r.poids_kg));
            expect(pesees).toHaveLength(5);
            expect(pesees[0]).toBe(70);
            expect(pesees[4]).toBeGreaterThan(pesees[0]);
            expect((await pool.query(`SELECT COUNT(*)::int AS n FROM releves_animal WHERE type_evenement = 'VACCINATION'`)).rows[0].n).toBe(6); // les 6 animaux encore au troupeau
            expect((await pool.query(`SELECT COUNT(*)::int AS n FROM releves_animal WHERE type_evenement = 'TRAITEMENT'`)).rows[0].n).toBe(2);
        });

        test('le module Élevage est inclus d’office : l’onglet marche en essai ET après le passage en Pro', async () => {
            const token = await ouvrir(TEL_ELEVEUR, 'elevage');
            const tenant = await tenantDe(TEL_ELEVEUR);
            expect((await pool.query(`SELECT modules_actifs FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0].modules_actifs).toEqual(['elevage']);

            const liste = await get('/api/elevage/animaux', token);
            expect(liste.status).toBe(200);
            expect(liste.body).toHaveLength(6); // les vivants (le vendu est masqué par défaut)

            const me = (await get('/api/auth/me', token)).body.utilisateur;
            expect(me.onglets).toEqual(expect.arrayContaining(['elevage']));

            // passage en Pro (ce que fait l'IPN de paiement : le plan change, modules_actifs reste)
            await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'PRO', montant_mensuel = 10000 WHERE tenant_id = $1`, [tenant]);
            expect((await get('/api/elevage/animaux', token)).status).toBe(200);
        });

        test('essai terminé : consultation seule, le troupeau reste lisible', async () => {
            const token = await ouvrir(TEL_ELEVEUR, 'elevage');
            const tenant = await tenantDe(TEL_ELEVEUR);
            await pool.query(`UPDATE organisation_abonnement_saas SET essai_fin_le = now() - interval '2 days' WHERE tenant_id = $1`, [tenant]);
            expect((await get('/api/elevage/animaux', token)).status).toBe(200);
        });

        test('« Supprimer la démo » retire le troupeau d’exemple sans toucher aux animaux réels', async () => {
            const token = await ouvrir(TEL_ELEVEUR, 'elevage');
            const tenant = await tenantDe(TEL_ELEVEUR);
            const bovins = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1 AND nom = 'Bovins'`, [tenant])).rows[0].id;
            const reel = await request(app).post('/api/elevage/animaux').set('Authorization', `Bearer ${token}`).send({ secteur_id: bovins, identifiant: 'MA-VACHE', espece: 'BOVIN', sexe: 'F', race: 'Gobra' });
            expect(reel.status).toBe(201);

            const res = await request(app).delete('/api/essai/demo').set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(200);
            expect(res.body.supprimes).toBe(7);
            const restants = (await get('/api/elevage/animaux?statut=TOUS', token)).body;
            expect(restants.map((a) => a.identifiant)).toEqual(['MA-VACHE']);
        });
    });

    test('les autres filières ne reçoivent aucun module supplémentaire', async () => {
        await ouvrir('+221771240003', 'avicole', 'Poulets');
        await ouvrir('+221771240004', 'piscicole', 'Poissons');
        const mods = (await pool.query(`SELECT modules_actifs FROM organisation_abonnement_saas`)).rows;
        expect(mods.every((m) => m.modules_actifs.length === 0)).toBe(true);
    });
});

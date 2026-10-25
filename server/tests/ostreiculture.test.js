const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

const TEL = '+221771250001';
const TEL_B = '+221771250002';

describe('module Ostréiculture — V1 (structures suivies, relevés, récoltes à la douzaine)', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        process.env.OSTREICULTURE_ACTIF = 'true';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai', 'production', 'auth', 'catalogue']);
    });
    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    const dernierCode = () => {
        const appels = require('../src/whatsapp').envoyerMessageWhatsapp.mock.calls;
        return appels[appels.length - 1][1].composants[0].parameters[0].text;
    };
    async function ouvrir(telephone = TEL, filiere = 'ostreiculture') {
        expect((await request(app).post('/api/essai/inscription').send({ nomFerme: `Ferme ${telephone}`, telephone, filiere })).status).toBe(202);
        const res = await request(app).post('/api/essai/verifier').send({ telephone, code: dernierCode() });
        expect(res.status).toBe(200);
        return res.body.token;
    }
    const auth = (r, t) => r.set('Authorization', `Bearer ${t}`);
    const get = (url, t) => auth(request(app).get(url), t);
    const post = (url, corps, t) => auth(request(app).post(url), t).send(corps);
    const tenantDe = async (tel) => (await pool.query(`SELECT tenant_id FROM utilisateurs WHERE telephone = $1`, [tel])).rows[0].tenant_id;
    const secteurDe = async (tenant) => (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1 AND nom = 'Ostréiculture'`, [tenant])).rows[0].id;

    async function creerStructure(token, tenant, surcharges = {}) {
        const secteur = await secteurDe(tenant);
        const res = await post('/api/production/lots', {
            secteur_id: secteur, code_lot: 'POCHE-1', quantite_initiale: 1000, date_demarrage: '2026-09-01',
            espece: 'Crassostrea gasar', site: 'Bolong de Toubacouta', type_structure: 'POCHE', origine_lot: 'CAPTAGE', ...surcharges,
        }, token);
        expect(res.status).toBe(201);
        return res.body;
    }

    describe('mise en service (filière cachée par défaut)', () => {
        test('fermée : non listée, non acceptée, et une inscription forcée donne une ferme d’aviculture', async () => {
            delete process.env.OSTREICULTURE_ACTIF;
            const f = (await request(app).get('/api/essai/filieres')).body;
            expect(f.publiques).not.toContain('ostreiculture');
            expect(f.acceptees).not.toContain('ostreiculture');
            await ouvrir(TEL, 'ostreiculture');
            const noms = (await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [await tenantDe(TEL)])).rows.map((s) => s.nom);
            expect(noms).toEqual(['Avicole']);
        });

        test('« lien » : acceptée mais jamais listée sur la page d’inscription', async () => {
            process.env.OSTREICULTURE_ACTIF = 'lien';
            const f = (await request(app).get('/api/essai/filieres')).body;
            expect(f.publiques).not.toContain('ostreiculture');
            expect(f.acceptees).toContain('ostreiculture');
            await ouvrir(TEL, 'ostreiculture');
            const noms = (await pool.query(`SELECT nom FROM secteurs WHERE tenant_id = $1`, [await tenantDe(TEL)])).rows.map((s) => s.nom);
            expect(noms).toEqual(['Ostréiculture']);
        });

        test('« true » : publique', async () => {
            const f = (await request(app).get('/api/essai/filieres')).body;
            expect(f.publiques).toContain('ostreiculture');
            expect(f.acceptees).toContain('ostreiculture');
        });
    });

    describe('ferme d’essai et démonstration', () => {
        test('crée le secteur, une structure de démo TERMINÉE (poches, captage) et ses données cohérentes', async () => {
            await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = (await pool.query(`SELECT * FROM lots_production WHERE tenant_id = $1`, [tenant])).rows[0];
            expect(lot).toMatchObject({ code_lot: 'Poches du bolong A (démo)', statut: 'TERMINE', est_demo: true, type_structure: 'POCHE', origine_lot: 'CAPTAGE', espece: 'Crassostrea gasar' });
            const releves = (await pool.query(`SELECT * FROM releves_journaliers WHERE lot_id = $1 ORDER BY date_releve`, [lot.id])).rows;
            expect(releves).toHaveLength(28);
            expect(Number(releves[0].taille_moyenne_cm)).toBeLessThan(2.5);
            expect(Number(releves[27].taille_moyenne_cm)).toBeGreaterThan(6);
            expect(releves.every((r) => Number(r.salinite_ppt) >= 24 && Number(r.salinite_ppt) <= 41)).toBe(true);
            const morts = releves.reduce((s, r) => s + r.mortalite, 0);
            const recoltes = (await pool.query(`SELECT * FROM recoltes_ostreicoles WHERE lot_id = $1`, [lot.id])).rows;
            const recolte = recoltes.reduce((s, r) => s + r.nombre, 0);
            expect(recoltes).toHaveLength(3);
            expect(recolte).toBe(792); // 66 douzaines
            // la mortalité du naissain est forte au début (rapport FAO : 30 à 50 %) mais pas tout l'élevage
            const mortPremiers = releves.slice(0, 4).reduce((s, r) => s + r.mortalite, 0);
            expect(mortPremiers / 1500).toBeGreaterThan(0.3);
            expect(morts / 1500).toBeLessThan(0.5);
            // l'effectif de la structure est cohérent avec ce qui est arrivé
            expect(Number(lot.quantite_initiale)).toBe(1500 - morts - recolte);
        });

        test('la démo vend à la douzaine : produit en DOUZAINE et deux commandes livrées rattachées à la structure', async () => {
            await ouvrir();
            const tenant = await tenantDe(TEL);
            const produit = (await pool.query(`SELECT nom, unite_mesure, est_demo FROM produits WHERE tenant_id = $1`, [tenant])).rows;
            expect(produit).toEqual([{ nom: 'Huîtres fraîches (démo)', unite_mesure: 'DOUZAINE', est_demo: true }]);
            const lignes = (await pool.query(`SELECT SUM(quantite)::int AS dz FROM lignes_commande l JOIN commandes c ON c.id = l.commande_id WHERE c.tenant_id = $1 AND l.lot_id IS NOT NULL`, [tenant])).rows[0];
            expect(lignes.dz).toBe(46);
        });

        test('même essai que les autres filières : 30 jours, une seule structure en cours', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const ab = (await pool.query(`SELECT plan, essai_debut_le, essai_fin_le FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];
            expect(ab.plan).toBe('ESSAI');
            expect(Math.round((new Date(ab.essai_fin_le) - new Date(ab.essai_debut_le)) / 86400000)).toBe(30);
            await creerStructure(token, tenant);
            const secteur = await secteurDe(tenant);
            const second = await post('/api/production/lots', { secteur_id: secteur, code_lot: 'POCHE-2', quantite_initiale: 100, date_demarrage: '2026-09-02' }, token);
            expect(second.status).toBe(402);
        });

        test('« Supprimer la démo » retire la structure d’exemple sans toucher à la vraie', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            await creerStructure(token, tenant);
            const res = await auth(request(app).delete('/api/essai/demo'), token);
            expect(res.status).toBe(200);
            const restants = (await pool.query(`SELECT code_lot FROM lots_production WHERE tenant_id = $1 AND deleted_at IS NULL`, [tenant])).rows;
            expect(restants.map((l) => l.code_lot)).toEqual(['POCHE-1']);
        });
    });

    describe('structure suivie et relevés', () => {
        test('enregistre site, type de structure et origine ; une valeur hors liste est ignorée', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant, { type_structure: 'FUSEE', origine_lot: 'captage' });
            expect(lot).toMatchObject({ site: 'Bolong de Toubacouta', type_structure: null, origine_lot: 'CAPTAGE' });
        });

        test('un relevé porte salinité, naissain, nombre mesuré et entretien ; la mortalité réduit l’effectif ; renvoyé deux fois il compte une fois', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const releve = { client_id: 'releve-ostrei-0001', lot_id: lot.id, date_releve: '2026-09-15', mortalite: 40, taille_moyenne_cm: 1.8, salinite_ppt: 27.5, temperature_eau: 29, naissain_capte: 120, nb_mesures: 25, entretien: ['NETTOYAGE', 'DEDOUBLAGE', 'PIRATE'] };
            expect((await post('/api/production/sync', { releves: [releve] }, token)).status).toBe(200);
            expect((await post('/api/production/sync', { releves: [releve] }, token)).status).toBe(200);
            const lignes = (await pool.query(`SELECT * FROM releves_journaliers WHERE lot_id = $1`, [lot.id])).rows;
            expect(lignes).toHaveLength(1);
            expect(lignes[0]).toMatchObject({ naissain_capte: 120, nb_mesures: 25, entretien: 'NETTOYAGE,DEDOUBLAGE' });
            expect(Number(lignes[0].salinite_ppt)).toBe(27.5);
            expect(Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [lot.id])).rows[0].quantite_initiale)).toBe(960);
        });

        test('valeurs absurdes (négatives, texte) : le relevé est enregistré, ces champs sont simplement vides', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const res = await post('/api/production/sync', { releves: [{ client_id: 'releve-ostrei-0002', lot_id: lot.id, date_releve: '2026-09-16', mortalite: 1, salinite_ppt: -3, naissain_capte: 'beaucoup', nb_mesures: -1 }] }, token);
            expect(res.status).toBe(200);
            const l = (await pool.query(`SELECT * FROM releves_journaliers WHERE lot_id = $1`, [lot.id])).rows[0];
            expect(l.salinite_ppt).toBeNull();
            expect(l.naissain_capte).toBeNull();
            expect(l.nb_mesures).toBeNull();
        });
    });

    describe('récoltes à la douzaine', () => {
        test('une récolte en douzaines retire les huîtres de l’effectif et renvoie le nombre (12 par douzaine)', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const res = await post(`/api/production/lots/${lot.id}/recoltes`, { date_recolte: '2026-10-20', douzaines: 10, destination: 'FRAIS', calibre_1: 60, calibre_2: 60 }, token);
            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ nombre: 120, destination: 'FRAIS', calibre_1: 60, calibre_2: 60, calibre_0: null });
            expect(Number(res.body.douzaines)).toBe(10);
            expect(Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [lot.id])).rows[0].quantite_initiale)).toBe(880);
        });

        test('en nombre seul : les douzaines sont déduites ; destination inconnue = vente fraîche', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const res = await post(`/api/production/lots/${lot.id}/recoltes`, { nombre: 90, destination: 'MARCHE_NOIR' }, token);
            expect(res.status).toBe(201);
            expect(Number(res.body.douzaines)).toBe(7.5);
            expect(res.body.destination).toBe('FRAIS');
        });

        test('refuse une récolte sans quantité, à zéro, ou d’une structure clôturée ou d’un autre secteur', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            expect((await post(`/api/production/lots/${lot.id}/recoltes`, {}, token)).status).toBe(400);
            expect((await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 0 }, token)).status).toBe(400);
            await auth(request(app).put(`/api/production/lots/${lot.id}/statut`), token).send({ statut: 'TERMINE' });
            const cloture = await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 1 }, token);
            expect(cloture.status).toBe(400);
            expect(cloture.body.erreur).toMatch(/clôturée/);

            const tokenB = await ouvrir(TEL_B, 'avicole');
            const tenantB = await tenantDe(TEL_B);
            const secteurB = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1`, [tenantB])).rows[0].id;
            const lotB = (await post('/api/production/lots', { secteur_id: secteurB, code_lot: 'AV-1', quantite_initiale: 100, date_demarrage: '2026-09-01' }, tokenB)).body;
            const autre = await post(`/api/production/lots/${lotB.id}/recoltes`, { douzaines: 1 }, tokenB);
            expect(autre.status).toBe(400);
        });

        test('trop récolté par rapport à l’effectif : accepté avec un avertissement, effectif ramené à zéro (jamais négatif)', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant, { quantite_initiale: 100 });
            const res = await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 20 }, token);
            expect(res.status).toBe(201);
            expect(res.body.avertissement).toMatch(/ramené à zéro/);
            expect(Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [lot.id])).rows[0].quantite_initiale)).toBe(0);
        });

        test('supprimer une récolte remet les huîtres dans l’effectif ; la liste ne la montre plus', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const r = (await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 5 }, token)).body;
            expect((await auth(request(app).delete(`/api/production/lots/${lot.id}/recoltes/${r.id}`), token)).status).toBe(204);
            expect(Number((await pool.query(`SELECT quantite_initiale FROM lots_production WHERE id = $1`, [lot.id])).rows[0].quantite_initiale)).toBe(1000);
            expect((await get(`/api/production/lots/${lot.id}/recoltes`, token)).body).toHaveLength(0);
            expect((await auth(request(app).delete(`/api/production/lots/${lot.id}/recoltes/${r.id}`), token)).status).toBe(404);
        });

        test('une autre ferme ne voit ni ne modifie ces récoltes', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant);
            const r = (await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 5 }, token)).body;
            const tokenB = await ouvrir(TEL_B);
            const liste = await get(`/api/production/lots/${lot.id}/recoltes`, tokenB);
            expect([403, 404, 200]).toContain(liste.status);
            if (liste.status === 200) expect(liste.body).toHaveLength(0);
            expect((await auth(request(app).delete(`/api/production/lots/${lot.id}/recoltes/${r.id}`), tokenB)).status).not.toBe(204);
            expect((await get(`/api/production/lots/${lot.id}/recoltes`, token)).body).toHaveLength(1);
        });
    });

    describe('synthèse d’une structure', () => {
        test('reconstitue l’effectif de départ (actuel + mortalité + récolté) et calcule mortalité et rendement', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const lot = await creerStructure(token, tenant, { quantite_initiale: 1000 });
            await post('/api/production/sync', { releves: [
                { client_id: 'releve-ostrei-0003', lot_id: lot.id, date_releve: '2026-09-10', mortalite: 100, taille_moyenne_cm: 2.1, salinite_ppt: 30 },
                { client_id: 'releve-ostrei-0004', lot_id: lot.id, date_releve: '2026-10-10', mortalite: 50, taille_moyenne_cm: 3.4, salinite_ppt: 26 },
            ] }, token);
            await post(`/api/production/lots/${lot.id}/recoltes`, { douzaines: 25 }, token); // 300 huîtres
            const s = (await get(`/api/production/lots/${lot.id}/ostreiculture`, token)).body;
            // départ = 1000 (début) : 1000 - 150 - 300 = 550 actuel, 550 + 150 + 300 = 1000
            expect(s).toMatchObject({ effectif_actuel: 550, effectif_depart: 1000, mortalite_totale: 150, mortalite_pct: 15, recolte_nombre: 300, rendement_pct: 30, taille_moyenne_cm: 3.4, salinite_ppt: 26 });
            expect(s.recolte_douzaines).toBe(25);
            const attendu = Math.floor((Date.now() - new Date('2026-09-01').getTime()) / 86400000);
            expect(Math.abs(s.jours_depuis_mise_a_l_eau - attendu)).toBeLessThanOrEqual(1);
        });

        test('refusée pour un lot d’un autre secteur', async () => {
            const token = await ouvrir(TEL_B, 'avicole');
            const tenant = await tenantDe(TEL_B);
            const secteur = (await pool.query(`SELECT id FROM secteurs WHERE tenant_id = $1`, [tenant])).rows[0].id;
            const lot = (await post('/api/production/lots', { secteur_id: secteur, code_lot: 'AV-9', quantite_initiale: 50, date_demarrage: '2026-09-01' }, token)).body;
            expect((await get(`/api/production/lots/${lot.id}/ostreiculture`, token)).status).toBe(400);
        });
    });

    describe('vente à la douzaine', () => {
        test('un produit peut être créé en douzaines (nouvelle unité de mesure)', async () => {
            const token = await ouvrir();
            const tenant = await tenantDe(TEL);
            const secteur = await secteurDe(tenant);
            const res = await post('/api/catalogue/produits', { secteur_id: secteur, nom: 'Huîtres fraîches', unite_mesure: 'DOUZAINE', prix_unitaire_b2b: 1400, prix_unitaire_b2c: 1500, quantite_initiale: 0 }, token);
            expect(res.status).toBe(201);
            expect(res.body.unite_mesure).toBe('DOUZAINE');
        });
    });
});

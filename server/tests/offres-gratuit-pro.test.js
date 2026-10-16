const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');
const {
    DUREE_ESSAI_JOURS,
    MODULES_GRATUIT,
    MODULES_SAAS,
    planEffectif,
    joursRestantsEssai,
    resoudreAcces,
    moduleAutorise,
    ongletsAutorises,
} = require('../src/modulesSaas');

// Jamais d'envoi réel d'e-mail : la création d'utilisateur exige un service d'e-mail configuré.
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));

const JOUR_MS = 24 * 3600 * 1000;
const MAINTENANT = new Date('2026-10-15T12:00:00Z');
const dans = (jours) => new Date(MAINTENANT.getTime() + jours * JOUR_MS);

// ---------------------------------------------------------------------------------------------------------------------
// Dossier Easystart, phase 2 : offres Gratuit / Essai (30 jours) / Pro tout inclus, appliquées par le serveur.
// Règle absolue : plan NULL = ferme « sur mesure », comportement HISTORIQUE inchangé (toutes les fermes existantes).
// ---------------------------------------------------------------------------------------------------------------------
describe('offres — logique pure', () => {
    test('planEffectif : sans plan ou sans ligne = sur mesure (null) ; PRO ; GRATUIT', () => {
        expect(planEffectif(undefined, MAINTENANT)).toBeNull();
        expect(planEffectif(null, MAINTENANT)).toBeNull();
        expect(planEffectif({ plan: null }, MAINTENANT)).toBeNull();
        expect(planEffectif({ plan: 'PRO' }, MAINTENANT)).toBe('PRO');
        expect(planEffectif({ plan: 'GRATUIT' }, MAINTENANT)).toBe('GRATUIT');
    });

    test("un essai est ESSAI jusqu'à sa fin, puis retombe sur GRATUIT (aussi sans date de fin)", () => {
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: dans(10) }, MAINTENANT)).toBe('ESSAI');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: dans(-1) }, MAINTENANT)).toBe('GRATUIT');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: MAINTENANT }, MAINTENANT)).toBe('GRATUIT');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: null }, MAINTENANT)).toBe('GRATUIT');
    });

    test('joursRestantsEssai : arrondi au jour supérieur, 0 une fois terminé', () => {
        expect(joursRestantsEssai({ essai_fin_le: dans(30) }, MAINTENANT)).toBe(30);
        expect(joursRestantsEssai({ essai_fin_le: new Date(MAINTENANT.getTime() + 3 * JOUR_MS - 60000) }, MAINTENANT)).toBe(3);
        expect(joursRestantsEssai({ essai_fin_le: dans(-2) }, MAINTENANT)).toBe(0);
        expect(joursRestantsEssai({}, MAINTENANT)).toBe(0);
        expect(DUREE_ESSAI_JOURS).toBe(30);
    });

    test('resoudreAcces : PRO et ESSAI ouvrent tout, GRATUIT impose sa liste, sur mesure inchangé', () => {
        expect(resoudreAcces([], 'PRO')).toBeNull();
        expect(resoudreAcces([], 'ESSAI')).toBeNull();
        // sur mesure : strictement l'ancien comportement
        expect(resoudreAcces(['paie'])).toEqual(resoudreAcces(['paie'], null));
        expect(resoudreAcces([])).toEqual({ souscrits: [], lecture: [] });
        // gratuit : modules_actifs est ignoré (même un pack ne contourne pas le Gratuit)
        const gratuit = resoudreAcces(['pack_tout_compris', 'paie'], 'GRATUIT');
        expect(gratuit.souscrits.sort()).toEqual([...MODULES_GRATUIT].sort());
        expect(moduleAutorise(gratuit, 'finance', 'POST')).toBe(true);
        expect(moduleAutorise(gratuit, 'paie', 'GET')).toBe(false);
        expect(moduleAutorise(gratuit, 'elevage', 'GET')).toBe(false);
        expect(ongletsAutorises(gratuit)).toEqual(expect.arrayContaining(['dashboard', 'production', 'intrants', 'clients', 'commandes', 'finance']));
        expect(ongletsAutorises(gratuit)).not.toContain('elevage');
        expect(ongletsAutorises(gratuit)).not.toContain('paie');
    });

    test('le Gratuit ne référence que des modules du catalogue', () => {
        const cles = MODULES_SAAS.map((m) => m.cle);
        for (const m of MODULES_GRATUIT) expect(cles).toContain(m);
    });
});

describe('offres — application par le serveur', () => {
    let pool;
    let app;
    let tenantId;
    let secteurId;
    let token;

    const definirOffre = (plan, { finEssaiJours = null, modules = [] } = {}) =>
        pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, plan, essai_debut_le, essai_fin_le)
             VALUES ($1, $2, 0, $3, $4, $5)`,
            [tenantId, modules, plan, finEssaiJours === null ? null : new Date(), finEssaiJours === null ? null : dans(finEssaiJours)]
        );
    const post = (url, corps, t = token) => request(app).post(url).set('Authorization', `Bearer ${t}`).send(corps);
    const get = (url, t = token) => request(app).get(url).set('Authorization', `Bearer ${t}`);
    const lot = (code) => ({ secteur_id: secteurId, code_lot: code, quantite_initiale: 500, date_demarrage: '2026-10-01' });
    const insererLot = async (code) =>
        (await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut) VALUES ($1, $2, $3, 500, '2026-10-01', 'EN_COURS') RETURNING id`,
            [tenantId, secteurId, code]
        )).rows[0].id;
    const releve = (lotId) => ({ lot_id: lotId, date_releve: '2026-10-15', mortalite: 1, conso_aliment_kg: 5 });

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Offres');
        secteurId = (await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Avicole') RETURNING id`, [tenantId])).rows[0].id;
        app = buildApp(pool, ['auth', 'production', 'paie', 'utilisateurs']);
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('ferme SUR MESURE (plan NULL) : aucune limite, /me sans offre — comportement historique', async () => {
        await definirOffre(null, { modules: ['pack_tout_compris'] });
        expect((await post('/api/production/lots', lot('A-1'))).status).toBe(201);
        expect((await post('/api/production/lots', lot('A-2'))).status).toBe(201);
        expect((await post('/api/production/lots', lot('A-3'))).status).toBe(201);
        expect((await get('/api/auth/me')).body.utilisateur.offre).toBeNull();
    });

    test('GRATUIT : un seul lot en cours (402), un nouveau lot après clôture, /me annonce l\'offre', async () => {
        await definirOffre('GRATUIT');
        const premier = await post('/api/production/lots', lot('G-1'));
        expect(premier.status).toBe(201);

        const second = await post('/api/production/lots', lot('G-2'));
        expect(second.status).toBe(402);
        expect(second.body.code).toBe('PLAN_GRATUIT_LIMITE_LOTS');
        expect(second.body.erreur).toMatch(/Pro/);

        const cloture = await request(app).put(`/api/production/lots/${premier.body.id}/statut`).set('Authorization', `Bearer ${token}`).send({ statut: 'TERMINE' });
        expect(cloture.status).toBe(200);
        expect((await post('/api/production/lots', lot('G-3'))).status).toBe(201);

        const me = (await get('/api/auth/me')).body.utilisateur;
        expect(me.offre).toEqual({ plan: 'GRATUIT', joursRestants: null });
        expect(me.onglets).toEqual(expect.arrayContaining(['production', 'finance']));
        expect(me.onglets).not.toContain('paie');
    });

    test('GRATUIT : Paie et Élevage refusés (MODULE_NON_SOUSCRIT), Production accessible', async () => {
        await definirOffre('GRATUIT');
        const paie = await get('/api/paie/employes');
        expect(paie.status).toBe(403);
        expect(paie.body.code).toBe('MODULE_NON_SOUSCRIT');
        expect((await get('/api/production/secteurs')).status).toBe(200);
    });

    test('ESSAI en cours : tout inclus, lots illimités, /me annonce les jours restants', async () => {
        await definirOffre('ESSAI', { finEssaiJours: 12 });
        expect((await post('/api/production/lots', lot('E-1'))).status).toBe(201);
        expect((await post('/api/production/lots', lot('E-2'))).status).toBe(201);
        expect((await get('/api/paie/employes')).status).toBe(200);
        const me = (await get('/api/auth/me')).body.utilisateur;
        expect(me.offre.plan).toBe('ESSAI');
        expect(me.offre.joursRestants).toBeGreaterThanOrEqual(11);
        expect(me.offre.joursRestants).toBeLessThanOrEqual(12);
        expect(me.onglets).toBeNull();
    });

    test('ESSAI terminé : retombe sur GRATUIT sans rien supprimer ; les lots de l\'essai restent consultables', async () => {
        await definirOffre('ESSAI', { finEssaiJours: -1 });
        const l1 = await insererLot('T-1');
        const l2 = await insererLot('T-2');

        expect((await post('/api/production/lots', lot('T-3'))).status).toBe(402);
        expect((await get('/api/paie/employes')).status).toBe(403);
        expect((await get('/api/auth/me')).body.utilisateur.offre.plan).toBe('GRATUIT');

        const lots = await get('/api/production/lots');
        expect(lots.status).toBe(200);
        expect(lots.body.map((l) => l.id).sort()).toEqual([l1, l2].sort()); // rien n'a disparu
    });

    test('GRATUIT : seul le plus ancien lot reçoit des relevés ; les autres sont consultables (402, jamais 403)', async () => {
        await definirOffre('GRATUIT');
        const suivi = await insererLot('S-1');
        const gele = await insererLot('S-2');

        const ok = await post('/api/production/sync', { releves: [releve(suivi)] });
        expect(ok.status).toBe(200);

        const refus = await post('/api/production/sync', { releves: [releve(gele)] });
        expect(refus.status).toBe(402); // 402 : la file hors ligne prendrait un 403 pour une session expirée
        expect(refus.body.erreur).toMatch(/consultable/);
        const n = await pool.query(`SELECT COUNT(*)::int AS n FROM releves_journaliers WHERE lot_id = $1`, [gele]);
        expect(n.rows[0].n).toBe(0);
    });

    test('PRO : tous les lots reçoivent des relevés', async () => {
        await definirOffre('PRO');
        const a = await insererLot('P-1');
        const b = await insererLot('P-2');
        expect((await post('/api/production/sync', { releves: [releve(a)] })).status).toBe(200);
        expect((await post('/api/production/sync', { releves: [releve(b)] })).status).toBe(200);
        expect((await get('/api/paie/employes')).status).toBe(200);
    });

    test("GRATUIT : un seul compte utilisateur (402) ; PRO et sur mesure peuvent ajouter l'équipe", async () => {
        const nouveau = { nom_complet: 'Ouvrier Test', email: 'ouvrier@test.sn', password: 'Motdepasse-Solide-2026', role: 'chef_prod', secteur_id: secteurId };

        await definirOffre('GRATUIT');
        const refus = await post('/api/utilisateurs', nouveau);
        expect(refus.status).toBe(402);
        expect(refus.body.code).toBe('PLAN_GRATUIT_LIMITE_UTILISATEURS');

        await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'PRO' WHERE tenant_id = $1`, [tenantId]);
        const accepte = await post('/api/utilisateurs', nouveau);
        expect(accepte.status).toBe(201);
    });
});

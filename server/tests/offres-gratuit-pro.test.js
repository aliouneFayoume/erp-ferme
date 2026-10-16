const jwt = require('jsonwebtoken');
const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');
const { signToken } = require('../src/auth');
const {
    DUREE_ESSAI_JOURS,
    MODULES_OFFRE,
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
// Offres (dossier Easystart, phase 2, décisions du propriétaire du 2026-10-15) :
//  - essai gratuit de 30 jours (1 lot en cours, 1 utilisateur, pas de relances automatiques) ;
//  - une fois l'essai fini : consultation seule jusqu'au passage en Pro, rien n'est supprimé ;
//  - Pro = les fonctions de la grille (la version complète est réservée à la ferme Massla) ;
//  - élevage, paie… : à la demande, module par module (modules_actifs).
// Règle absolue : plan NULL = ferme « sur mesure », comportement HISTORIQUE inchangé (toutes les fermes existantes).
// ---------------------------------------------------------------------------------------------------------------------
describe('offres — logique pure', () => {
    test('planEffectif : sans plan ni ligne = sur mesure (null) ; PRO', () => {
        expect(planEffectif(undefined, MAINTENANT)).toBeNull();
        expect(planEffectif(null, MAINTENANT)).toBeNull();
        expect(planEffectif({ plan: null }, MAINTENANT)).toBeNull();
        expect(planEffectif({ plan: 'PRO' }, MAINTENANT)).toBe('PRO');
    });

    test("un essai est ESSAI jusqu'à sa fin, puis EXPIRE (consultation seule) — aussi sans date de fin", () => {
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: dans(10) }, MAINTENANT)).toBe('ESSAI');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: dans(-1) }, MAINTENANT)).toBe('EXPIRE');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: MAINTENANT }, MAINTENANT)).toBe('EXPIRE');
        expect(planEffectif({ plan: 'ESSAI', essai_fin_le: null }, MAINTENANT)).toBe('EXPIRE');
    });

    test('joursRestantsEssai : arrondi au jour supérieur, 0 une fois terminé', () => {
        expect(joursRestantsEssai({ essai_fin_le: dans(30) }, MAINTENANT)).toBe(30);
        expect(joursRestantsEssai({ essai_fin_le: new Date(MAINTENANT.getTime() + 3 * JOUR_MS - 60000) }, MAINTENANT)).toBe(3);
        expect(joursRestantsEssai({ essai_fin_le: dans(-2) }, MAINTENANT)).toBe(0);
        expect(joursRestantsEssai({}, MAINTENANT)).toBe(0);
        expect(DUREE_ESSAI_JOURS).toBe(30);
    });

    test("ESSAI, EXPIRE et PRO : les modules de l'offre, pas la version complète", () => {
        for (const offre of ['ESSAI', 'EXPIRE', 'PRO']) {
            const acces = resoudreAcces([], offre);
            expect([...acces.souscrits].sort()).toEqual([...MODULES_OFFRE].sort());
            for (const reserve of ['elevage', 'paie', 'logistique', 'comptabilite', 'support']) {
                expect(moduleAutorise(acces, reserve, 'GET')).toBe(false);
            }
            expect(moduleAutorise(acces, 'finance', 'POST')).toBe(true);
            expect(ongletsAutorises(acces)).toEqual(expect.arrayContaining(['dashboard', 'production', 'intrants', 'clients', 'commandes', 'finance']));
            expect(ongletsAutorises(acces)).not.toContain('elevage');
            expect(ongletsAutorises(acces)).not.toContain('paie');
        }
    });

    test("un module « sur demande » (élevage, paie) s'ajoute aux modules de l'offre sans les remplacer", () => {
        const acces = resoudreAcces(['elevage'], 'PRO');
        expect(acces.souscrits).toEqual(expect.arrayContaining([...MODULES_OFFRE, 'elevage']));
        expect(moduleAutorise(acces, 'elevage', 'POST')).toBe(true);
        expect(moduleAutorise(acces, 'paie', 'GET')).toBe(false);
    });

    test("le Pack tout compris reste la version complète : jamais atteint par une offre sans qu'on l'y mette", () => {
        expect(resoudreAcces(['pack_tout_compris'], 'PRO')).toBeNull(); // réservé aux fermes à qui on l'accorde (Massla)
        expect(resoudreAcces([], 'PRO')).not.toBeNull();
    });

    test('ferme sur mesure : strictement le comportement historique', () => {
        expect(resoudreAcces(['paie'])).toEqual(resoudreAcces(['paie'], null));
        expect(resoudreAcces([])).toEqual({ souscrits: [], lecture: [] });
        expect(resoudreAcces(undefined, null)).toBeNull();
    });

    test("les modules de l'offre ne référencent que des modules du catalogue", () => {
        const cles = MODULES_SAAS.map((m) => m.cle);
        for (const m of MODULES_OFFRE) expect(cles).toContain(m);
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
    const put = (url, corps, t = token) => request(app).put(url).set('Authorization', `Bearer ${t}`).send(corps);
    const get = (url, t = token) => request(app).get(url).set('Authorization', `Bearer ${t}`);
    const lot = (code) => ({ secteur_id: secteurId, code_lot: code, quantite_initiale: 500, date_demarrage: '2026-10-01' });
    const insererLot = async (code) =>
        (await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut) VALUES ($1, $2, $3, 500, '2026-10-01', 'EN_COURS') RETURNING id`,
            [tenantId, secteurId, code]
        )).rows[0].id;
    const releve = (lotId) => ({ lot_id: lotId, date_releve: '2026-10-15', mortalite: 1, conso_aliment_kg: 5 });
    const nouvelUtilisateur = { nom_complet: 'Ouvrier Test', email: 'ouvrier@test.sn', password: 'Motdepasse-Solide-2026', role: 'chef_prod' };

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

    test("ESSAI : un seul lot en cours (402), un nouveau lot après clôture, /me annonce l'essai et les jours restants", async () => {
        await definirOffre('ESSAI', { finEssaiJours: 12 });
        const premier = await post('/api/production/lots', lot('E-1'));
        expect(premier.status).toBe(201);

        const second = await post('/api/production/lots', lot('E-2'));
        expect(second.status).toBe(402);
        expect(second.body.code).toBe('ESSAI_LIMITE_LOTS');
        expect(second.body.erreur).toMatch(/Pro/);

        const cloture = await put(`/api/production/lots/${premier.body.id}/statut`, { statut: 'TERMINE' });
        expect(cloture.status).toBe(200);
        expect((await post('/api/production/lots', lot('E-3'))).status).toBe(201);

        const me = (await get('/api/auth/me')).body.utilisateur;
        expect(me.offre.plan).toBe('ESSAI');
        expect(me.offre.joursRestants).toBeGreaterThanOrEqual(11);
        expect(me.offre.joursRestants).toBeLessThanOrEqual(12);
        expect(me.onglets).toEqual(expect.arrayContaining(['production', 'finance']));
        expect(me.onglets).not.toContain('paie');
    });

    test('ESSAI : la version complète est fermée (Paie refusée), Production accessible', async () => {
        await definirOffre('ESSAI', { finEssaiJours: 20 });
        const paie = await get('/api/paie/employes');
        expect(paie.status).toBe(403);
        expect(paie.body.code).toBe('MODULE_NON_SOUSCRIT');
        expect((await get('/api/production/secteurs')).status).toBe(200);
    });

    test('ESSAI : seul le plus ancien lot reçoit des relevés ; les autres sont consultables (402, jamais 403)', async () => {
        await definirOffre('ESSAI', { finEssaiJours: 20 });
        const suivi = await insererLot('S-1');
        const gele = await insererLot('S-2');

        expect((await post('/api/production/sync', { releves: [releve(suivi)] })).status).toBe(200);

        const refus = await post('/api/production/sync', { releves: [releve(gele)] });
        expect(refus.status).toBe(402); // 402 : la file hors ligne prendrait un 403 pour une session expirée
        expect(refus.body.erreur).toMatch(/consultable/);
        const n = await pool.query(`SELECT COUNT(*)::int AS n FROM releves_journaliers WHERE lot_id = $1`, [gele]);
        expect(n.rows[0].n).toBe(0);
    });

    test("ESSAI : un seul compte utilisateur (402) ; l'équipe est réservée au Pro", async () => {
        await definirOffre('ESSAI', { finEssaiJours: 20 });
        const refus = await post('/api/utilisateurs', { ...nouvelUtilisateur, secteur_id: secteurId });
        expect(refus.status).toBe(402);
        expect(refus.body.code).toBe('ESSAI_LIMITE_UTILISATEURS');

        await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'PRO' WHERE tenant_id = $1`, [tenantId]);
        expect((await post('/api/utilisateurs', { ...nouvelUtilisateur, secteur_id: secteurId })).status).toBe(201);
    });

    test("ESSAI TERMINÉ : consultation seule — les lectures passent, toute écriture est refusée (402 ESSAI_TERMINE), rien n'a disparu", async () => {
        await definirOffre('ESSAI', { finEssaiJours: -1 });
        const l1 = await insererLot('T-1');
        const l2 = await insererLot('T-2');

        const lots = await get('/api/production/lots');
        expect(lots.status).toBe(200);
        expect(lots.body.map((l) => l.id).sort()).toEqual([l1, l2].sort());
        expect((await get('/api/production/secteurs')).status).toBe(200);

        for (const reponse of [
            await post('/api/production/lots', lot('T-3')),
            await post('/api/production/sync', { releves: [releve(l1)] }),
            await put(`/api/production/lots/${l1}/statut`, { statut: 'TERMINE' }),
            await post('/api/utilisateurs', { ...nouvelUtilisateur, secteur_id: secteurId }),
        ]) {
            expect(reponse.status).toBe(402);
            expect(reponse.body.code).toBe('ESSAI_TERMINE');
            expect(reponse.body.erreur).toMatch(/Pro/);
        }
        const releves = await pool.query(`SELECT COUNT(*)::int AS n FROM releves_journaliers`);
        expect(releves.rows[0].n).toBe(0);

        const me = await get('/api/auth/me'); // /api/auth reste accessible : on garde la main sur son compte
        expect(me.status).toBe(200);
        expect(me.body.utilisateur.offre).toEqual({ plan: 'EXPIRE', joursRestants: null });
    });

    test('ESSAI TERMINÉ : une session de support (impersonation) peut toujours dépanner la ferme', async () => {
        await definirOffre('ESSAI', { finEssaiJours: -1 });
        const utilisateur = jwt.decode(token);
        const tokenSupport = signToken(
            { id: utilisateur.id, role_nom: 'admin', nom_complet: 'Support', secteur_id: null, tenant_id: tenantId },
            { viaImpersonation: true, supervisorId: utilisateur.id }
        );
        const reponse = await post('/api/production/lots', lot('SUP-1'), tokenSupport);
        expect(reponse.status).toBe(201);
    });

    test('PRO : tous les lots reçoivent des relevés, l\'équipe est permise, la version complète reste fermée', async () => {
        await definirOffre('PRO');
        const a = await insererLot('P-1');
        const b = await insererLot('P-2');
        expect((await post('/api/production/sync', { releves: [releve(a)] })).status).toBe(200);
        expect((await post('/api/production/sync', { releves: [releve(b)] })).status).toBe(200);
        expect((await post('/api/production/lots', lot('P-3'))).status).toBe(201);
        expect((await post('/api/utilisateurs', { ...nouvelUtilisateur, secteur_id: secteurId })).status).toBe(201);
        expect((await get('/api/paie/employes')).status).toBe(403); // Paie n'est pas dans l'offre
    });

    test('PRO + module accordé à la demande (Paie) : accessible', async () => {
        await definirOffre('PRO', { modules: ['paie'] });
        expect((await get('/api/paie/employes')).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Le support choisit l'offre d'une ferme depuis la vue plateforme (PUT /organisations/:id/abonnement-saas).
// ---------------------------------------------------------------------------------------------------------------------
describe("offres — choix de l'offre par le support (vue plateforme)", () => {
    let pool;
    let app;
    let tenantSupport;
    let tenantClient;
    let token;

    const enregistrer = (corps, tenant = tenantClient) =>
        request(app)
            .put(`/api/plateforme/organisations/${tenant}/abonnement-saas`)
            .set('Authorization', `Bearer ${token}`)
            .send({ modulesActifs: [], montantMensuel: 0, ...corps });
    const ligne = async (tenant = tenantClient) => (await pool.query(`SELECT * FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantSupport = await creerOrganisation(pool, 'Support');
        tenantClient = await creerOrganisation(pool, 'Ferme Cliente');
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantSupport, estSuperviseurPlateforme: true });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test("ESSAI : démarre l'essai de 30 jours (dates posées), plan ESSAI", async () => {
        const avant = Date.now();
        const res = await enregistrer({ offre: 'ESSAI' });
        expect(res.status).toBe(200);
        const l = await ligne();
        expect(l.plan).toBe('ESSAI');
        const jours = (new Date(l.essai_fin_le).getTime() - new Date(l.essai_debut_le).getTime()) / JOUR_MS;
        expect(Math.round(jours)).toBe(30);
        expect(new Date(l.essai_debut_le).getTime()).toBeGreaterThanOrEqual(avant - 1000);
    });

    test("enregistrer à nouveau un essai en cours ne le prolonge pas ; « redémarrer » le relance", async () => {
        await enregistrer({ offre: 'ESSAI' });
        const premier = await ligne();
        // on recule l'essai de 10 jours pour pouvoir distinguer « inchangé » de « redémarré »
        await pool.query(`UPDATE organisation_abonnement_saas SET essai_debut_le = $2, essai_fin_le = $3 WHERE tenant_id = $1`, [
            tenantClient,
            new Date(Date.now() - 10 * JOUR_MS),
            new Date(Date.now() + 20 * JOUR_MS),
        ]);
        const recule = await ligne();

        await enregistrer({ offre: 'ESSAI' });
        expect(new Date((await ligne()).essai_fin_le).getTime()).toBe(new Date(recule.essai_fin_le).getTime());

        await enregistrer({ offre: 'ESSAI', redemarrerEssai: true });
        const relance = await ligne();
        expect(new Date(relance.essai_fin_le).getTime()).toBeGreaterThan(new Date(recule.essai_fin_le).getTime() + 9 * JOUR_MS);
        expect(Math.abs(new Date(relance.essai_fin_le).getTime() - new Date(premier.essai_fin_le).getTime())).toBeLessThan(5000);
    });

    test('PRO : plan PRO et date de conversion posée une seule fois', async () => {
        await enregistrer({ offre: 'ESSAI' });
        await enregistrer({ offre: 'PRO', montantMensuel: 10000 });
        const l = await ligne();
        expect(l.plan).toBe('PRO');
        expect(Number(l.montant_mensuel)).toBe(10000);
        expect(l.converti_pro_le).not.toBeNull();
        const date = new Date(l.converti_pro_le).getTime();

        await enregistrer({ offre: 'PRO', montantMensuel: 10000 });
        expect(new Date((await ligne()).converti_pro_le).getTime()).toBe(date);
    });

    test('SUR_MESURE : replace la ferme dans le régime historique (plan NULL)', async () => {
        await enregistrer({ offre: 'PRO' });
        await enregistrer({ offre: 'SUR_MESURE', modulesActifs: ['paie'], montantMensuel: 35000 });
        const l = await ligne();
        expect(l.plan).toBeNull();
        expect(l.modules_actifs).toEqual(['paie']);
    });

    test("un appel sans « offre » (ancien client de l'API) ne touche pas aux colonnes d'offre", async () => {
        await enregistrer({ offre: 'PRO' });
        await enregistrer({ modulesActifs: ['paie'], montantMensuel: 12000 });
        const l = await ligne();
        expect(l.plan).toBe('PRO');
        expect(l.modules_actifs).toEqual(['paie']);
    });

    test('offre inconnue : refusée (400)', async () => {
        const res = await enregistrer({ offre: 'PLATINE' });
        expect(res.status).toBe(400);
        expect(await ligne()).toBeUndefined();
    });

    test("le catalogue annonce les modules de l'offre et la durée de l'essai", async () => {
        const res = await request(app).get('/api/plateforme/modules-saas').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.modulesOffre).toEqual(MODULES_OFFRE);
        expect(res.body.dureeEssaiJours).toBe(DUREE_ESSAI_JOURS);
    });
});

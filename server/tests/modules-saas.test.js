const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');
const {
    SOCLE_ESSENTIEL,
    MODULES_SAAS,
    PACK_TOUT_COMPRIS,
    resoudreAcces,
    moduleAutorise,
    ongletsAutorises,
} = require('../src/modulesSaas');

describe('modulesSaas — catalogue (fonctions pures)', () => {
    test('sans ligne d\'abonnement (null) ou avec le Pack : aucune restriction', () => {
        expect(resoudreAcces(null)).toBeNull();
        expect(resoudreAcces(undefined)).toBeNull();
        expect(resoudreAcces([PACK_TOUT_COMPRIS.cle])).toBeNull();
        expect(ongletsAutorises(null)).toBeNull();
        expect(moduleAutorise(null, 'paie', 'DELETE')).toBe(true);
    });

    test('une liste vide = Socle seul : aucun module, mais les onglets du Socle', () => {
        const acces = resoudreAcces([]);
        expect(acces).toEqual({ souscrits: [], lecture: [] });
        expect(moduleAutorise(acces, 'paie')).toBe(false);
        const onglets = ongletsAutorises(acces);
        expect(onglets).toEqual(expect.arrayContaining(['dashboard', 'production', 'catalogue', 'intrants']));
        expect(onglets).not.toContain('paie');
    });

    test('ignore les clés inconnues (ancien module, faute de frappe)', () => {
        const acces = resoudreAcces(['paie', 'module_fantome']);
        expect(acces.souscrits).toEqual(['paie']);
    });

    test('la lecture implicite (dépendances) ne vaut que pour GET/HEAD, jamais pour une écriture', () => {
        const acces = resoudreAcces(['commandes_fournisseurs']);
        expect(moduleAutorise(acces, 'clients_abonnements', 'GET')).toBe(true);
        expect(moduleAutorise(acces, 'clients_abonnements', 'HEAD')).toBe(true);
        expect(moduleAutorise(acces, 'clients_abonnements', 'POST')).toBe(false);
        expect(moduleAutorise(acces, 'clients_abonnements', 'PUT')).toBe(false);
        // ...et ne donne pas l'onglet correspondant
        expect(ongletsAutorises(acces)).not.toContain('clients');
        expect(ongletsAutorises(acces)).toEqual(expect.arrayContaining(['commandes', 'fournisseurs']));
    });

    test('les dépendances de lecture ne référencent que des modules existants', () => {
        const cles = MODULES_SAAS.map((m) => m.cle);
        for (const m of MODULES_SAAS) {
            for (const dep of m.lecture) expect(cles).toContain(dep);
            expect(m.lecture).not.toContain(m.cle);
        }
    });
});

// Garde-fou de cohérence : un onglet ajouté au frontend sans être classé ici serait visible par tous
// les abonnés (ou pire, jamais masqué) sans que personne ne s'en aperçoive.
describe('modulesSaas — chaque onglet du frontend est classé exactement une fois', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'js', 'app.js'), 'utf-8');
    const bloc = appJs.slice(appJs.indexOf('const TAB_DEFS = ['), appJs.indexOf('];', appJs.indexOf('const TAB_DEFS = [')));
    const clesFrontend = [...bloc.matchAll(/\{\s*key:\s*'([^']+)'/g)].map((m) => m[1]).filter((k) => k !== 'plateforme');

    test('TAB_DEFS a bien été lu', () => {
        expect(clesFrontend.length).toBeGreaterThan(15);
    });

    test.each(clesFrontend)('onglet « %s »', (cle) => {
        const proprietaires = [];
        if (SOCLE_ESSENTIEL.onglets.includes(cle)) proprietaires.push('socle');
        for (const m of MODULES_SAAS) if (m.onglets.includes(cle)) proprietaires.push(m.cle);
        expect(proprietaires).toHaveLength(1);
    });

    test('le catalogue ne référence aucun onglet inexistant', () => {
        const classes = [...SOCLE_ESSENTIEL.onglets, ...MODULES_SAAS.flatMap((m) => m.onglets)];
        for (const o of classes) expect(clesFrontend).toContain(o);
    });
});

describe('modules SaaS — application par le serveur', () => {
    let pool;
    let app;
    let tenantId;
    let token;

    async function abonnement(modules, { tenant = tenantId, actif = true } = {}) {
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif) VALUES ($1, $2, 40000, $3)`,
            [tenant, modules, actif]
        );
    }

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test');
        app = buildApp(pool, ['auth', 'paie', 'comptabilite', 'clients', 'commandes', 'production', 'finance', 'parametres-paiement', 'parametres-ferme']);
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
    });

    afterEach(async () => {
        await pool.end();
    });

    const get = (url, t = token) => request(app).get(url).set('Authorization', `Bearer ${t}`);

    test('ferme sans ligne d\'abonnement : rien n\'est restreint (comportement historique)', async () => {
        expect((await get('/api/paie/employes')).status).toBe(200);
        expect((await get('/api/comptabilite/depenses')).status).toBe(200);
        const me = await get('/api/auth/me');
        expect(me.body.utilisateur.onglets).toBeNull();
        expect(me.body.utilisateur.modules).toBeNull();
    });

    test('Socle seul : les modules non souscrits sont refusés (403 MODULE_NON_SOUSCRIT), le Socle reste accessible', async () => {
        await abonnement([]);

        const paie = await get('/api/paie/employes');
        expect(paie.status).toBe(403);
        expect(paie.body.code).toBe('MODULE_NON_SOUSCRIT');
        expect(paie.body.module).toBe('paie');
        expect(paie.body.erreur).toMatch(/Paie/);

        expect((await get('/api/comptabilite/depenses')).status).toBe(403);
        expect((await get('/api/production/secteurs')).status).toBe(200); // Socle
        expect((await get('/api/parametres-ferme')).status).toBe(200); // Socle
    });

    test('/auth/me renvoie les onglets autorisés (Socle + modules souscrits) et la liste des modules', async () => {
        await abonnement(['paie']);
        const me = await get('/api/auth/me');
        const { onglets, modules } = me.body.utilisateur;
        expect(modules).toEqual(['paie']);
        expect(onglets).toEqual(expect.arrayContaining(['dashboard', 'production', 'catalogue', 'intrants', 'paie']));
        expect(onglets).not.toContain('comptabilite');
        expect(onglets).not.toContain('finance');
    });

    test('un module souscrit ouvre ses routes, pas celles des autres', async () => {
        await abonnement(['paie']);
        expect((await get('/api/paie/employes')).status).toBe(200);
        expect((await get('/api/comptabilite/depenses')).status).toBe(403);
    });

    test('le Pack tout compris ouvre tout et /auth/me ne restreint rien', async () => {
        await abonnement([PACK_TOUT_COMPRIS.cle]);
        expect((await get('/api/paie/employes')).status).toBe(200);
        expect((await get('/api/comptabilite/depenses')).status).toBe(200);
        expect((await get('/api/auth/me')).body.utilisateur.onglets).toBeNull();
    });

    test('lecture implicite : Commandes lit les clients (GET) mais ne peut pas en créer (POST)', async () => {
        await abonnement(['commandes_fournisseurs']);
        expect((await get('/api/clients')).status).toBe(200);

        const creation = await request(app)
            .post('/api/clients')
            .set('Authorization', `Bearer ${token}`)
            .send({ nom: 'X', type_client: 'B2C', telephone: '221700000001', gps_lat: 14.7, gps_lng: -17.4 });
        expect(creation.status).toBe(403);
        expect(creation.body.code).toBe('MODULE_NON_SOUSCRIT');
    });

    test('Finance verrouille les réglages PayDunya/WhatsApp, pas les informations de la ferme (Socle)', async () => {
        await abonnement([]);
        expect((await get('/api/parametres-paiement/paiement')).status).toBe(403);
        expect((await get('/api/parametres-ferme')).status).toBe(200);
    });

    test('la ferme plateforme (Ferme Massla) n\'est jamais restreinte, même avec un abonnement Socle seul', async () => {
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [tenantId]);
        await abonnement([]);
        expect((await get('/api/paie/employes')).status).toBe(200);
        expect((await get('/api/auth/me')).body.utilisateur.onglets).toBeNull();
    });

    test('une modification du superviseur s\'applique immédiatement, sans reconnexion (même token)', async () => {
        await abonnement([]);
        expect((await get('/api/paie/employes')).status).toBe(403);
        await pool.query(`UPDATE organisation_abonnement_saas SET modules_actifs = $1 WHERE tenant_id = $2`, [['paie'], tenantId]);
        expect((await get('/api/paie/employes')).status).toBe(200);
    });

    test('un module ne fuit pas d\'une ferme à l\'autre', async () => {
        const autre = await creerOrganisation(pool, 'Autre Ferme');
        const tokenAutre = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: autre });
        await abonnement(['paie']); // ferme A seulement
        await abonnement([], { tenant: autre }); // ferme B : Socle seul
        expect((await get('/api/paie/employes')).status).toBe(200);
        expect((await get('/api/paie/employes', tokenAutre)).status).toBe(403);
    });

    test('le webhook IPN PayDunya (public, sans authentification) n\'est jamais bloqué par les modules', async () => {
        await abonnement([]);
        const res = await request(app).post('/api/finance/paiements/ipn').send({ data: {} });
        expect(res.body.code).not.toBe('MODULE_NON_SOUSCRIT');
        expect(res.status).not.toBe(403);
    });
});

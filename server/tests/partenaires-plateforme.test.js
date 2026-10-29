const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

jest.mock('../src/whatsapp');
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn(),
}));

describe('plateforme — partenaires (affiliation), versements et commission due', () => {
    let pool;
    let app;
    let tokenSuperviseur;
    let tokenAdminNormal;
    let tenantMassla;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantMassla = await creerOrganisation(pool, 'Ferme Massla');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantMassla, estSuperviseurPlateforme: true });
        tokenAdminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantMassla, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme']);
    });
    afterEach(async () => {
        await pool.end();
    });

    const auth = (r, t = tokenSuperviseur) => r.set('Authorization', `Bearer ${t}`);
    const creerPartenaire = (corps = {}) =>
        auth(request(app).post('/api/plateforme/partenaires')).send({ code: 'TERANGA', nom: 'Ingénieur Teranga', ...corps });
    const liste = async () => (await auth(request(app).get('/api/plateforme/partenaires'))).body;

    /** Ferme rattachée à un partenaire, créée à une date donnée (la fenêtre de commission part de cette date). */
    async function fermeRattachee(partenaireId, nom, creeLe) {
        const r = await pool.query(`INSERT INTO organisations (nom, partenaire_id, cree_le) VALUES ($1, $2, $3) RETURNING id`, [nom, partenaireId, creeLe]);
        return r.rows[0].id;
    }
    let jeton = 0;
    /** Paiement SaaS d'une ferme (facture + tentative PayDunya), au statut et à la date donnés. */
    async function paiement(tenantId, montant, statut, datePaiement) {
        jeton += 1;
        const f = await pool.query(
            `INSERT INTO factures_saas (tenant_id, type, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', $2, 'PAYEE', '2027-01-01') RETURNING id`,
            [tenantId, montant]
        );
        await pool.query(
            `INSERT INTO paiements_saas (facture_saas_id, tenant_id, emetteur_tenant_id, montant, token, reference_interne, url_paiement, statut, date_paiement)
             VALUES ($1, $2, $3, $4, $5, $6, 'https://paydunya.test/x', $7, $8)`,
            [f.rows[0].id, tenantId, tenantMassla, montant, `tok-${jeton}`, `ref-${jeton}`, statut, datePaiement]
        );
    }

    test('accès refusé à un admin sans le flag superviseur (lecture, création, modification, versement)', async () => {
        expect((await auth(request(app).get('/api/plateforme/partenaires'), tokenAdminNormal)).status).toBe(403);
        expect((await auth(request(app).post('/api/plateforme/partenaires'), tokenAdminNormal).send({ code: 'X1', nom: 'X' })).status).toBe(403);
        expect((await auth(request(app).put('/api/plateforme/partenaires/1'), tokenAdminNormal).send({ actif: false })).status).toBe(403);
        expect((await auth(request(app).post('/api/plateforme/partenaires/1/versements'), tokenAdminNormal).send({ montant_fcfa: 100 })).status).toBe(403);
        expect((await request(app).get('/api/plateforme/partenaires')).status).toBe(401);
    });

    test('création : code mis en majuscules, valeurs par défaut 20 % pendant 12 mois, tracée dans le journal', async () => {
        const res = await creerPartenaire({ code: ' teranga ' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ code: 'TERANGA', nom: 'Ingénieur Teranga', commission_pct: 20, commission_mois: 12, actif: true });
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'partenaires'`)).rows[0].n).toBe(1);
    });

    test('doublon de code (même en minuscules) : 409', async () => {
        expect((await creerPartenaire()).status).toBe(201);
        const doublon = await creerPartenaire({ code: 'teranga', nom: 'Autre' });
        expect(doublon.status).toBe(409);
        expect(doublon.body.erreur).toMatch(/déjà/);
    });

    test('valeurs du corps validées : code, nom, pourcentage, durée', async () => {
        for (const mauvais of [
            { code: 'A B' },
            { code: '' },
            { code: 'A'.repeat(41) },
            { nom: '' },
            { nom: 'x'.repeat(101) },
            { commission_pct: 101 },
            { commission_pct: -1 },
            { commission_pct: 12.5 },
            { commission_pct: 'beaucoup' },
            { commission_mois: -3 },
            { commission_mois: 1.5 },
            { commission_mois: 1201 },
        ]) {
            const res = await creerPartenaire(mauvais);
            expect(res.status).toBe(400);
        }
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM partenaires')).rows[0].n).toBe(0);
    });

    test('modification : nom, commission, désactivation ; le code ne change pas ; 404 si inconnu', async () => {
        const { id } = (await creerPartenaire()).body;
        const res = await auth(request(app).put(`/api/plateforme/partenaires/${id}`)).send({ nom: 'Nouveau nom', commission_pct: 30, commission_mois: 6, actif: false, code: 'AUTRE' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ code: 'TERANGA', nom: 'Nouveau nom', commission_pct: 30, commission_mois: 6, actif: false });
        expect((await auth(request(app).put(`/api/plateforme/partenaires/${id}`)).send({ commission_pct: 500 })).status).toBe(400);
        expect((await auth(request(app).put('/api/plateforme/partenaires/9999')).send({ actif: true })).status).toBe(404);
        expect((await auth(request(app).put(`/api/plateforme/partenaires/${id}`)).send({})).status).toBe(400);
    });

    test('versement : montant entier > 0, note facultative, tracé dans le journal ; 404 si partenaire inconnu', async () => {
        const { id } = (await creerPartenaire()).body;
        for (const mauvais of [0, -5, 10.5, '12abc', null, undefined, 1e12]) {
            expect((await auth(request(app).post(`/api/plateforme/partenaires/${id}/versements`)).send({ montant_fcfa: mauvais })).status).toBe(400);
        }
        expect((await auth(request(app).post(`/api/plateforme/partenaires/${id}/versements`)).send({ montant_fcfa: 1000, note: 'x'.repeat(501) })).status).toBe(400);
        expect((await auth(request(app).post(`/api/plateforme/partenaires/${id}/versements`)).send({ montant_fcfa: 1000, date_versement: 'hier' })).status).toBe(400);

        const ok = await auth(request(app).post(`/api/plateforme/partenaires/${id}/versements`)).send({ montant_fcfa: 5000, note: 'Wave du 29/10' });
        expect(ok.status).toBe(201);
        expect(ok.body).toMatchObject({ partenaire_id: id, montant_fcfa: 5000, note: 'Wave du 29/10' });
        expect((await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'versements_partenaires'`)).rows[0].n).toBe(1);
        expect((await auth(request(app).post('/api/plateforme/partenaires/9999/versements')).send({ montant_fcfa: 100 })).status).toBe(404);
    });

    test('commission due : seuls les paiements confirmés DANS la fenêtre de commission_mois comptent, moins les versements', async () => {
        const { id } = (await creerPartenaire({ commission_pct: 20, commission_mois: 12 })).body;
        const ferme = await fermeRattachee(id, 'Ferme A', '2026-01-15T10:00:00Z');
        await paiement(ferme, 10000, 'VALIDE', '2026-03-01T10:00:00Z'); // dans la fenêtre
        await paiement(ferme, 10000, 'VALIDE', '2026-12-31T10:00:00Z'); // dans la fenêtre (11,5 mois)
        await paiement(ferme, 10000, 'VALIDE', '2027-02-01T10:00:00Z'); // hors fenêtre (> 12 mois après la création)
        await paiement(ferme, 10000, 'ECHOUE', '2026-04-01T10:00:00Z'); // jamais compté
        await paiement(ferme, 10000, 'EN_ATTENTE', null); // jamais compté
        await paiement(ferme, 10000, 'DOUBLON', '2026-05-01T10:00:00Z'); // jamais compté
        // Paiement d'une ferme SANS partenaire : ne compte pour personne.
        const libre = await creerOrganisation(pool, 'Ferme libre');
        await paiement(libre, 10000, 'VALIDE', '2026-03-01T10:00:00Z');

        let p = (await liste()).find((x) => x.code === 'TERANGA');
        expect(p.commission_due_fcfa).toBe(4000); // 20 % de 20 000
        expect(p.payantes).toBe(1);

        await auth(request(app).post(`/api/plateforme/partenaires/${id}/versements`)).send({ montant_fcfa: 1500 });
        p = (await liste()).find((x) => x.code === 'TERANGA');
        expect(p.commission_due_fcfa).toBe(2500);
        expect(p.verse_fcfa).toBe(1500);
    });

    test('la fenêtre se calcule ferme par ferme, depuis la création de CHAQUE ferme', async () => {
        const { id } = (await creerPartenaire({ commission_pct: 10, commission_mois: 3 })).body;
        const tot = await fermeRattachee(id, 'Ferme tôt', '2026-01-10T00:00:00Z'); // fenêtre jusqu'au 10 avril
        const tard = await fermeRattachee(id, 'Ferme tard', '2026-06-10T00:00:00Z'); // fenêtre jusqu'au 10 septembre
        await paiement(tot, 10000, 'VALIDE', '2026-05-01T00:00:00Z'); // hors fenêtre pour « tôt »
        await paiement(tard, 10000, 'VALIDE', '2026-05-01T00:00:00Z'); // AVANT la création de « tard » : jamais compté
        await paiement(tard, 10000, 'VALIDE', '2026-08-01T00:00:00Z'); // dans la fenêtre de « tard »
        const p = (await liste())[0];
        expect(p.commission_due_fcfa).toBe(1000);
        expect(p.payantes).toBe(2); // « payante » = au moins un paiement confirmé, quelle que soit la date
    });

    test('commission_mois = 0 : aucune commission ; pourcentage arrondi à l\'entier inférieur', async () => {
        const zero = (await creerPartenaire({ code: 'ZERO', commission_mois: 0 })).body;
        const f0 = await fermeRattachee(zero.id, 'Ferme zéro', '2026-01-01T00:00:00Z');
        await paiement(f0, 10000, 'VALIDE', '2026-01-02T00:00:00Z');
        const tiers = (await creerPartenaire({ code: 'TIERS', commission_pct: 33 })).body;
        const f1 = await fermeRattachee(tiers.id, 'Ferme tiers', '2026-01-01T00:00:00Z');
        await paiement(f1, 10001, 'VALIDE', '2026-01-02T00:00:00Z');
        const l = await liste();
        expect(l.find((x) => x.code === 'ZERO').commission_due_fcfa).toBe(0);
        expect(l.find((x) => x.code === 'TIERS').commission_due_fcfa).toBe(3300); // 3300,33 -> 3300
    });

    test('compteurs : inscrits, actifs (au moins un relevé réel, hors ferme démo) et payants', async () => {
        const { id } = (await creerPartenaire()).body;
        const a = await fermeRattachee(id, 'Ferme A', '2026-01-01T00:00:00Z');
        const b = await fermeRattachee(id, 'Ferme B', '2026-01-01T00:00:00Z');
        await fermeRattachee(id, 'Ferme C', '2026-01-01T00:00:00Z');
        const user = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: a });
        const uid = (await pool.query('SELECT id FROM utilisateurs ORDER BY id DESC LIMIT 1')).rows[0].id;
        expect(user).toBeTruthy();

        const lot = async (tenant, code, estDemo) =>
            (await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, est_demo) VALUES ($1, 1, $2, 100, '2026-01-01', 'EN_COURS', $3) RETURNING id`,
                [tenant, code, estDemo]
            )).rows[0].id;
        // A : relevé sur un vrai lot -> active. B : relevés seulement sur le lot de démonstration -> pas active. C : rien.
        const lotA = await lot(a, 'L1', false);
        await pool.query(`INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite) VALUES ($1, $2, '2026-01-05', 1)`, [lotA, uid]);
        const lotB = await lot(b, 'DEMO', true);
        await pool.query(`INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite) VALUES ($1, $2, '2026-01-05', 1)`, [lotB, uid]);
        await paiement(a, 10000, 'VALIDE', '2026-02-01T00:00:00Z');

        const p = (await liste())[0];
        expect(p).toMatchObject({ code: 'TERANGA', inscriptions: 3, actives: 1, payantes: 1, commission_due_fcfa: 2000 });
    });

    test('la liste renvoie tous les champs attendus, y compris les partenaires inactifs', async () => {
        await creerPartenaire();
        await creerPartenaire({ code: 'ALPHA', nom: 'Alpha', actif: false });
        const l = await liste();
        expect(l).toHaveLength(2);
        expect(Object.keys(l[0])).toEqual(expect.arrayContaining(['id', 'code', 'nom', 'commission_pct', 'commission_mois', 'actif', 'inscriptions', 'actives', 'payantes', 'commission_due_fcfa']));
        expect(l.find((x) => x.code === 'ALPHA').actif).toBe(false);
    });
});

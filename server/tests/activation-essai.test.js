const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

const JOUR_MS = 24 * 3600 * 1000;

describe("plateforme — suivi de l'essai gratuit : inscription, source, activation, conversion", () => {
    let pool;
    let app;
    let tokenSuperviseur;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        const massla = await creerOrganisation(pool, 'Ferme Massla');
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [massla]);
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: massla, estSuperviseurPlateforme: true });
        app = buildApp(pool, ['plateforme', 'essai']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function journal(tenantId, table, action, joursAvant) {
        await pool.query(`INSERT INTO audit_logs (tenant_id, table_name, action, impersonation, cree_le) VALUES ($1, $2, $3, FALSE, $4)`, [
            tenantId,
            table,
            action,
            new Date(Date.now() - joursAvant * JOUR_MS),
        ]);
    }
    async function ferme(nom, { plan = 'ESSAI', source = 'essai', debutIlYa = 5, convertiPro = false } = {}) {
        const tenant = await creerOrganisation(pool, nom);
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif, plan, essai_debut_le, essai_fin_le, source_inscription, converti_pro_le)
             VALUES ($1, '{}', 0, TRUE, $2, $3, $4, $5, $6)`,
            [tenant, plan, new Date(Date.now() - debutIlYa * JOUR_MS), new Date(Date.now() + (30 - debutIlYa) * JOUR_MS), source, convertiPro ? new Date() : null]
        );
        return tenant;
    }
    const lire = async () => {
        const res = await request(app).get('/api/plateforme/activite').set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(200);
        return res.body;
    };

    test("chaque essai porte son suivi, et l'entonnoir compte inscrits, connectés, activés et convertis par porte d'entrée", async () => {
        const active = await ferme('Essai activé', { source: 'essai' });
        const connecteSansSaisie = await ferme('Essai connecté', { source: 'essai' });
        await ferme('Essai muet', { source: 'essai' });
        const converti = await ferme('Essai converti', { source: 'demo', plan: 'PRO', convertiPro: true });

        await journal(active, 'utilisateurs', 'LOGIN', 2);
        await journal(active, 'releves_journaliers', 'CREATE', 1);
        await journal(connecteSansSaisie, 'utilisateurs', 'LOGIN', 1);
        await journal(converti, 'utilisateurs', 'LOGIN', 3);
        await journal(converti, 'releves_journaliers', 'CREATE', 2);

        const { fermes, entonnoir } = await lire();
        const parNom = Object.fromEntries(fermes.map((f) => [f.nom, f]));

        expect(parNom['Essai activé'].essai).toMatchObject({ plan: 'ESSAI', offre_effective: 'ESSAI', source: 'essai', jours_saisie_30j: 1, active: true, converti_pro_le: null });
        expect(parNom['Essai activé'].essai.jours_restants).toBe(25);
        expect(parNom['Essai connecté'].essai).toMatchObject({ jours_saisie_30j: 0, active: false });
        expect(parNom['Essai connecté'].connectee).toBe(true);
        expect(parNom['Essai muet'].connectee).toBe(false);
        expect(parNom['Essai converti'].essai).toMatchObject({ plan: 'PRO', source: 'demo', active: true });
        expect(parNom['Essai converti'].essai.converti_pro_le).not.toBeNull();

        expect(entonnoir.essai).toEqual({ inscrits: 3, connectes: 2, actives: 1, convertis: 0 });
        expect(entonnoir.demo).toEqual({ inscrits: 1, connectes: 1, actives: 1, convertis: 1 });
    });

    test("une ferme sur mesure n'a pas de suivi d'essai et n'entre pas dans l'entonnoir", async () => {
        await creerOrganisation(pool, 'Ferme cliente');
        const { fermes, entonnoir } = await lire();
        expect(fermes.find((f) => f.nom === 'Ferme cliente').essai).toBeNull();
        expect(entonnoir).toEqual({});
    });

    test("un essai terminé le dit (offre effective EXPIRE) mais garde son suivi", async () => {
        await ferme('Essai terminé', { debutIlYa: 40 });
        const { fermes } = await lire();
        expect(fermes.find((f) => f.nom === 'Essai terminé').essai).toMatchObject({ plan: 'ESSAI', offre_effective: 'EXPIRE', jours_restants: 0 });
    });

    test("supprimer la ferme démo n'est pas de la saisie : l'essai ne devient pas « activé » pour autant", async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        const { creerFermeEssai } = require('../src/creerFermeEssai');
        const creee = await creerFermeEssai(pool, { nomFerme: 'Essai démo supprimée', telephone: '+221771110001', source: 'essai' });
        const token = require('../src/auth').signToken({ ...creee.admin, role_nom: 'admin' });

        const del = await request(app).delete('/api/essai/demo').set('Authorization', `Bearer ${token}`);
        expect(del.status).toBe(200);
        expect(del.body.supprimes).toBe(1);

        const { fermes } = await lire();
        const f = fermes.find((x) => x.nom === 'Essai démo supprimée');
        expect(f.essai).toMatchObject({ source: 'essai', jours_saisie_30j: 0, active: false });
        expect(f.saisies_30j).toBe(0);
        delete process.env.ESSAI_AUTONOME_ACTIF;
    });
});

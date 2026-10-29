const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

// Jamais de vrai appel à l'API Meta : on intercepte l'envoi du code (voir essai-autonome.test.js).
jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

const TEL = '+221771112233';

describe('essai gratuit — code partenaire (affiliation)', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        // Limiteurs de débit instanciés au chargement de la route : remise à zéro par test.
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai']);
    });

    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    const creerPartenaire = async (code = 'TERANGA', actif = true) =>
        (await pool.query(`INSERT INTO partenaires (code, nom, actif) VALUES ($1, 'Ingénieur Teranga', $2) RETURNING id`, [code, actif])).rows[0].id;
    const inscrire = (corps, application = app) =>
        request(application).post('/api/essai/inscription').send({ nomFerme: 'Ferme du Test', telephone: TEL, ...corps });
    const messagesEnvoyes = () => require('../src/whatsapp').envoyerMessageWhatsapp.mock.calls.length;

    test('code valide : la ferme est rattachée au partenaire, avec le code saisi', async () => {
        const id = await creerPartenaire();
        const res = await inscrire({ code_partenaire: 'TERANGA' });
        expect(res.status).toBe(202);
        const org = (await pool.query('SELECT partenaire_id, code_partenaire_saisi FROM organisations')).rows[0];
        expect(org.partenaire_id).toBe(id);
        expect(org.code_partenaire_saisi).toBe('TERANGA');
        expect(messagesEnvoyes()).toBe(1);
    });

    test("le code peut aussi arriver sous le nom « ref » (paramètre d'URL)", async () => {
        const id = await creerPartenaire();
        expect((await inscrire({ ref: 'TERANGA' })).status).toBe(202);
        expect((await pool.query('SELECT partenaire_id FROM organisations')).rows[0].partenaire_id).toBe(id);
    });

    test('casse et espaces normalisés (« teranga » entouré d\'espaces = TERANGA)', async () => {
        const id = await creerPartenaire();
        expect((await inscrire({ code_partenaire: '  teranga  ' })).status).toBe(202);
        const org = (await pool.query('SELECT partenaire_id, code_partenaire_saisi FROM organisations')).rows[0];
        expect(org.partenaire_id).toBe(id);
        expect(org.code_partenaire_saisi).toBe('TERANGA');
    });

    test('code absent ou vide : comportement inchangé, aucun rattachement', async () => {
        await creerPartenaire();
        expect((await inscrire({})).status).toBe(202);
        const vide = await inscrire({ nomFerme: 'Autre ferme', telephone: '+221772223344', code_partenaire: '   ' });
        expect(vide.status).toBe(202);
        const orgs = (await pool.query('SELECT partenaire_id, code_partenaire_saisi FROM organisations')).rows;
        expect(orgs).toHaveLength(2);
        for (const o of orgs) {
            expect(o.partenaire_id).toBeNull();
            expect(o.code_partenaire_saisi).toBeNull();
        }
    });

    test("le code ne change rien à la période d'essai : 30 jours, gratuit, comme sans code", async () => {
        await creerPartenaire();
        await inscrire({ code_partenaire: 'TERANGA' });
        const abo = (await pool.query('SELECT plan, essai_debut_le, essai_fin_le, montant_mensuel FROM organisation_abonnement_saas')).rows[0];
        expect(abo.plan).toBe('ESSAI');
        expect(Math.round((new Date(abo.essai_fin_le) - new Date(abo.essai_debut_le)) / 86400000)).toBe(30);
        expect(Number(abo.montant_mensuel)).toBe(0);
    });

    test('code inconnu : 400, aucune ferme créée et AUCUN message WhatsApp dépensé', async () => {
        await creerPartenaire();
        const res = await inscrire({ code_partenaire: 'INCONNU' });
        expect(res.status).toBe(400);
        expect(res.body.erreur).toBe('Code partenaire inconnu. Vérifiez-le ou laissez le champ vide.');
        expect(messagesEnvoyes()).toBe(0);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM organisations')).rows[0].n).toBe(0);
    });

    test('partenaire inactif : refusé comme un code inconnu', async () => {
        await creerPartenaire('TERANGA', false);
        const res = await inscrire({ code_partenaire: 'TERANGA' });
        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/Code partenaire inconnu/);
        expect(messagesEnvoyes()).toBe(0);
    });

    test('caractères interdits ou code trop long : refusé sans message ni ferme', async () => {
        await creerPartenaire();
        for (const mauvais of ['TERA NGA', "T'; DROP TABLE partenaires;--", '<b>X</b>', 'A'.repeat(41), 12345]) {
            const res = await inscrire({ code_partenaire: mauvais });
            expect(res.status).toBe(400);
        }
        expect(messagesEnvoyes()).toBe(0);
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM organisations')).rows[0].n).toBe(0);
    });

    test('le plafond quotidien de codes reste appliqué avec un code partenaire', async () => {
        await creerPartenaire();
        process.env.ESSAI_PLAFOND_CODES_JOUR = '1';
        expect((await inscrire({ code_partenaire: 'TERANGA' })).status).toBe(202);
        const second = await inscrire({ nomFerme: 'F2', telephone: '+221773334455', code_partenaire: 'TERANGA' });
        expect(second.status).toBe(503);
    });
});

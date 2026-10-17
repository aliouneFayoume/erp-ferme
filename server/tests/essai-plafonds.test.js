const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

// Jamais de vrai appel à Meta depuis la suite : on intercepte l'envoi (voir essai-autonome.test.js).
jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

describe('essai autonome — plafonds quotidiens de codes WhatsApp (budget et harcèlement)', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
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

    const inscrire = (n, telephone) => request(app).post('/api/essai/inscription').send({ nomFerme: `Ferme ${n}`, telephone });
    const nbEnvois = () => require('../src/whatsapp').envoyerMessageWhatsapp.mock.calls.length;
    const nbFermes = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM organisations')).rows[0].n;
    const nbCodesTraces = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'CODE_ENVOYE'`)).rows[0].n;

    test("plafond global : une fois atteint, plus d'inscription (503 explicite), aucune ferme créée, aucun message envoyé", async () => {
        process.env.ESSAI_PLAFOND_CODES_JOUR = '2';
        expect((await inscrire(1, '+221770100001')).status).toBe(202);
        expect((await inscrire(2, '+221770100002')).status).toBe(202);
        expect(await nbCodesTraces()).toBe(2);

        const refuse = await inscrire(3, '+221770100003');
        expect(refuse.status).toBe(503);
        expect(refuse.body.code).toBe('ESSAI_SATURE');
        expect(refuse.body.erreur).toMatch(/saturé/);
        expect(await nbFermes()).toBe(2);
        expect(nbEnvois()).toBe(2);

        // une demande de code pour un compte existant est refusée aussi : le plafond est bien global
        expect((await request(app).post('/api/essai/code').send({ telephone: '+221770100001' })).status).toBe(503);
    });

    test("les codes d'hier ne comptent pas : le plafond repart à zéro chaque jour (UTC)", async () => {
        process.env.ESSAI_PLAFOND_CODES_JOUR = '1';
        expect((await inscrire(1, '+221770100004')).status).toBe(202);
        expect((await inscrire(2, '+221770100005')).status).toBe(503);

        await pool.query(`UPDATE audit_logs SET cree_le = now() - interval '2 days' WHERE action = 'CODE_ENVOYE'`);
        expect((await inscrire(2, '+221770100005')).status).toBe(202);
    });

    /** Passe le délai d'une minute entre deux envois, sans toucher au plafond quotidien. */
    const demanderCode = async (tel) => {
        await pool.query(`UPDATE utilisateurs SET login_code_envoye_le = now() - interval '5 minutes'`);
        return request(app).post('/api/essai/code').send({ telephone: tel });
    };

    test("numéro non confirmé : 1 code par jour — le second est silencieusement refusé (même réponse, rien n'est révélé)", async () => {
        const tel = '+221770100006';
        expect((await inscrire(1, tel)).status).toBe(202); // le code de l'inscription
        const avant = nbEnvois();
        const second = await demanderCode(tel);
        expect(second.status).toBe(202); // même réponse qu'un envoi réussi
        expect(second.body.message).toMatch(/code à 6 chiffres/);
        expect(nbEnvois()).toBe(avant); // mais rien n'est parti
        // ré-inscrire le même numéro le même jour n'envoie rien de plus non plus
        await pool.query(`UPDATE utilisateurs SET login_code_envoye_le = now() - interval '5 minutes'`);
        expect((await inscrire(1, tel)).status).toBe(202);
        expect(nbEnvois()).toBe(avant);
    });

    test("le lendemain, le numéro non confirmé peut recevoir un nouveau code", async () => {
        const tel = '+221770100010';
        await inscrire(1, tel);
        const avant = nbEnvois();
        await pool.query(`UPDATE audit_logs SET cree_le = now() - interval '2 days' WHERE action = 'CODE_ENVOYE'`);
        await demanderCode(tel);
        expect(nbEnvois()).toBe(avant + 1);
    });

    test("une fois le numéro confirmé, autant de codes que voulu : plus aucun plafond par numéro", async () => {
        const tel = '+221770100011';
        await inscrire(1, tel);
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        const code = envoyerMessageWhatsapp.mock.calls[0][1].composants[0].parameters[0].text;
        expect((await request(app).post('/api/essai/verifier').send({ telephone: tel, code })).status).toBe(200);

        // 6 demandes : sous la limite par adresse IP (8 par heure, voir routes/essai.js), qui reste en vigueur et protège
        // contre un robot ; seul le plafond PAR NUMÉRO disparaît une fois le compte confirmé.
        const avant = nbEnvois();
        for (let i = 0; i < 6; i += 1) {
            expect((await demanderCode(tel)).status).toBe(202);
        }
        expect(nbEnvois()).toBe(avant + 6); // les 6 codes sont partis : bien plus que le plafond de 1 d'un numéro non confirmé
    });

    test("le plafond non confirmé est propre à chaque compte : un autre numéro n'est pas affecté", async () => {
        expect((await inscrire(1, '+221770100007')).status).toBe(202);
        expect((await inscrire(2, '+221770100008')).status).toBe(202);
        expect(nbEnvois()).toBe(2);
    });

    test("valeurs par défaut sensées (300 par jour, 1 par numéro non confirmé) et variables invalides ignorées", () => {
        const { plafondsCodes } = require('../src/essaiAutonome');
        expect(plafondsCodes()).toEqual({ global: 300, nonConfirmeParNumero: 1 });
        process.env.ESSAI_PLAFOND_CODES_JOUR = 'abc';
        process.env.ESSAI_PLAFOND_CODES_NON_CONFIRME_JOUR = '-5';
        expect(plafondsCodes()).toEqual({ global: 300, nonConfirmeParNumero: 1 });
        process.env.ESSAI_PLAFOND_CODES_JOUR = '50';
        process.env.ESSAI_PLAFOND_CODES_NON_CONFIRME_JOUR = '3';
        expect(plafondsCodes()).toEqual({ global: 50, nonConfirmeParNumero: 3 });
    });

    test("un usage normal ne touche jamais les plafonds : inscription, vérification, reconnexion le lendemain", async () => {
        const tel = '+221770100009';
        expect((await inscrire(1, tel)).status).toBe(202);
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        const code = envoyerMessageWhatsapp.mock.calls[0][1].composants[0].parameters[0].text;
        expect((await request(app).post('/api/essai/verifier').send({ telephone: tel, code })).status).toBe(200);
        // vérifier ne consomme aucun plafond
        expect(await nbCodesTraces()).toBe(1);
    });
});

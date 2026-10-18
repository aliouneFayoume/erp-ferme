const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

// Jamais de vrai envoi : WhatsApp (code de connexion de l'essai) et e-mail (vérification) sont interceptés.
jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));

const TEL = '+221771112299';
const MDP = 'Motdepasse#2026';

describe('essai autonome — sécuriser son compte (e-mail + mot de passe)', () => {
    let pool;
    let app;
    let emailService;
    let token;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        emailService = require('../src/email');
        emailService.estConfigure.mockReturnValue(true);
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai', 'auth']);

        await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme Sécurisée', telephone: TEL });
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        const appels = envoyerMessageWhatsapp.mock.calls;
        const code = appels[appels.length - 1][1].composants[0].parameters[0].text;
        const res = await request(app).post('/api/essai/verifier').send({ telephone: TEL, code });
        token = res.body.token;
        expect(token).toBeTruthy();
    });
    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    const securiser = (corps, jeton = token) => request(app).post('/api/auth/securiser-compte').set('Authorization', `Bearer ${jeton}`).send(corps);
    const me = async (jeton = token) => (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${jeton}`)).body.utilisateur;
    const ligneUtilisateur = async () => (await pool.query('SELECT * FROM utilisateurs WHERE telephone = $1', [TEL])).rows[0];

    test("avant : /me annonce un compte non sécurisé (téléphone seul)", async () => {
        const u = await me();
        expect(u).toMatchObject({ email: null, emailEnAttente: false, compteSecurise: false, telephone: TEL });
    });

    test("pose l'e-mail et le mot de passe, envoie le lien de vérification, garde la session de l'appelant", async () => {
        const res = await securiser({ email: 'Gerant@Ferme-Test.sn', password: MDP });
        expect(res.status).toBe(200);
        expect(res.body.email).toBe('gerant@ferme-test.sn');
        expect(emailService.envoyerEmailVerification).toHaveBeenCalledTimes(1);
        expect(emailService.envoyerEmailVerification.mock.calls[0][0]).toBe('gerant@ferme-test.sn');

        const ligne = await ligneUtilisateur();
        expect(ligne.email).toBe('gerant@ferme-test.sn');
        expect(ligne.email_verifie).toBe(false);
        expect(ligne.email_verification_token_hash).toBeTruthy();

        // la nouvelle session fonctionne, l'ancienne (version précédente) est invalidée
        expect((await me(res.body.token)).emailEnAttente).toBe(true);
        expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    });

    test("tant que l'e-mail n'est pas vérifié, la connexion par e-mail est refusée ; après le clic, elle marche", async () => {
        await securiser({ email: 'gerant@ferme-test.sn', password: MDP });

        const avant = await request(app).post('/api/auth/login').send({ email: 'gerant@ferme-test.sn', password: MDP });
        expect(avant.status).toBe(403);
        expect(avant.body.code).toBe('EMAIL_NON_VERIFIE');

        const jeton = emailService.envoyerEmailVerification.mock.calls[0][2];
        expect((await request(app).get(`/api/auth/verifier-email?token=${jeton}`)).status).toBe(200);

        const apres = await request(app).post('/api/auth/login').send({ email: 'gerant@ferme-test.sn', password: MDP });
        expect(apres.status).toBe(200);
        expect(apres.body.token).toBeTruthy();
        expect((await me(apres.body.token)).compteSecurise).toBe(true);
    });

    test("le code WhatsApp reste utilisable après la sécurisation", async () => {
        await securiser({ email: 'gerant@ferme-test.sn', password: MDP });
        const demande = await request(app).post('/api/essai/code').send({ telephone: TEL });
        expect(demande.status).toBe(202);
    });

    test("faute de frappe dans l'adresse : on peut la corriger tant qu'elle n'est pas vérifiée", async () => {
        // chaque envoi renvoie une nouvelle session : on repart de celle-ci (l'écran fait de même avec Api.setSession)
        const premiere = (await securiser({ email: 'gerant@ferme-tets.sn', password: MDP })).body.token;
        const session = (await securiser({ email: 'gerant@ferme-test.sn', password: MDP }, premiere)).body.token;
        expect(session).toBeTruthy();
        expect((await ligneUtilisateur()).email).toBe('gerant@ferme-test.sn');
        expect(emailService.envoyerEmailVerification).toHaveBeenCalledTimes(2);
    });

    test("un compte déjà sécurisé (e-mail vérifié) ne repasse pas par là : 409", async () => {
        const premier = await securiser({ email: 'gerant@ferme-test.sn', password: MDP });
        await pool.query('UPDATE utilisateurs SET email_verifie = TRUE WHERE telephone = $1', [TEL]);
        const res = await securiser({ email: 'autre@ferme-test.sn', password: MDP }, premier.body.token);
        expect(res.status).toBe(409);
        expect((await ligneUtilisateur()).email).toBe('gerant@ferme-test.sn');
    });

    test("refuse un mot de passe faible, une adresse invalide ou factice, des champs manquants", async () => {
        expect((await securiser({ email: 'gerant@ferme-test.sn', password: 'court' })).status).toBe(400);
        expect((await securiser({ email: 'pas-un-email', password: MDP })).status).toBe(400);
        expect((await securiser({ email: 'test@example.com', password: MDP })).status).toBe(400);
        expect((await securiser({ email: 'gerant@ferme-test.sn' })).status).toBe(400);
        expect((await ligneUtilisateur()).email).toBeNull();
    });

    test("refuse une adresse déjà utilisée par un autre compte (unique sur toute la plateforme)", async () => {
        const autre = await pool.query(`SELECT id FROM roles LIMIT 1`);
        await pool.query(
            `INSERT INTO organisations (nom) VALUES ('Autre ferme')`
        );
        const org = (await pool.query(`SELECT id FROM organisations WHERE nom = 'Autre ferme'`)).rows[0].id;
        await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif, email_verifie)
             VALUES ($1, 'Autre', 'pris@ferme-test.sn', 'x', $2, TRUE, TRUE)`,
            [org, autre.rows[0].id]
        );
        const res = await securiser({ email: 'pris@ferme-test.sn', password: MDP });
        expect(res.status).toBe(409);
        expect((await ligneUtilisateur()).email).toBeNull();
    });

    test("si l'e-mail ne peut pas partir : 502 et rien n'est modifié ; service e-mail absent : 503", async () => {
        emailService.envoyerEmailVerification.mockRejectedValueOnce(new Error('Resend indisponible'));
        expect((await securiser({ email: 'gerant@ferme-test.sn', password: MDP })).status).toBe(502);
        expect((await ligneUtilisateur()).email).toBeNull();

        emailService.estConfigure.mockReturnValue(false);
        expect((await securiser({ email: 'gerant@ferme-test.sn', password: MDP })).status).toBe(503);
        expect((await ligneUtilisateur()).email).toBeNull();
    });

    test("exige une session", async () => {
        const res = await request(app).post('/api/auth/securiser-compte').send({ email: 'gerant@ferme-test.sn', password: MDP });
        expect(res.status).toBe(401);
    });

    test("l'opération est tracée dans le journal d'audit", async () => {
        await securiser({ email: 'gerant@ferme-test.sn', password: MDP });
        const r = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'utilisateurs' AND details::text LIKE '%securisation_compte%'`);
        expect(r.rows[0].n).toBe(1);
    });
});

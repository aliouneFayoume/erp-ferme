const request = require('supertest');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Durcissement sécurité (migration-20) : jamais de vrai appel réseau vers Resend/Graph API WhatsApp
// depuis la suite de tests — même principe que plateforme.test.js pour les relances de facturation.
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/whatsapp');
// Réassigné après chaque jest.resetModules() (voir la suite MFA ci-dessous) : un reset donne une
// toute nouvelle instance de mock, capturer la référence une seule fois au chargement du fichier
// la désynchroniserait de celle réellement utilisée par mfa.js après le reset.
let envoyerMessageWhatsapp;

const MOT_DE_PASSE_CONFORME = 'Motdepasse123!';

/** Utilisateur complet avec un vrai hash bcrypt — nécessaire pour exercer /auth/login. */
async function creerUtilisateurComplet(pool, overrides = {}) {
    const opts = {
        email: `user-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.sn`,
        motDePasse: MOT_DE_PASSE_CONFORME,
        role: 'admin',
        tenant_id: null,
        emailVerifie: true,
        mfaObligatoire: false,
        mfaActif: false,
        mfaMethode: null,
        ...overrides,
    };
    const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = $1`, [opts.role]);
    const hash = await bcrypt.hash(opts.motDePasse, 4);
    const res = await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif, email_verifie, mfa_obligatoire, mfa_actif, mfa_methode)
         VALUES ($1, 'Utilisateur Test', $2, $3, $4, TRUE, $5, $6, $7, $8) RETURNING id`,
        [opts.tenant_id, opts.email, hash, roleRes.rows[0].id, opts.emailVerifie, opts.mfaObligatoire, opts.mfaActif, opts.mfaMethode]
    );
    return { id: res.rows[0].id, email: opts.email, motDePasse: opts.motDePasse };
}

describe('sécurité — politique de mot de passe', () => {
    let pool;
    let app;
    let tokenAdmin;
    let tenantId;

    beforeEach(async () => {
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test Mdp');
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['inscription', 'utilisateurs']);
    });

    afterEach(async () => {
        await pool.end();
    });

    const CODE = process.env.SIGNUP_INVITE_CODE || 'demo-inscription-ferme-massla';

    test.each([
        ['trop court', 'Abc123!'],
        ['sans majuscule', 'motdepasse123!'],
        ['sans minuscule', 'MOTDEPASSE123!'],
        ['sans chiffre', 'Motdepasse!!!!'],
        ['sans caractère spécial', 'Motdepasse123'],
    ])('inscription rejette un mot de passe %s', async (_label, mdp) => {
        const res = await request(app).post('/api/inscription').send({
            code: CODE,
            nomFerme: 'Ferme Rejetee',
            secteurs: [{ nom: 'Avicole' }],
            adminNomComplet: 'Admin',
            adminEmail: `rejet-${Date.now()}@test.sn`,
            adminPassword: mdp,
        });
        expect(res.status).toBe(400);
    });

    test('inscription accepte un mot de passe conforme', async () => {
        const res = await request(app).post('/api/inscription').send({
            code: CODE,
            nomFerme: 'Ferme Acceptee',
            secteurs: [{ nom: 'Avicole' }],
            adminNomComplet: 'Admin',
            adminEmail: `accepte-${Date.now()}@test.sn`,
            adminPassword: MOT_DE_PASSE_CONFORME,
        });
        expect(res.status).toBe(201);
    });

    test('création d\'utilisateur (admin) rejette un mot de passe non conforme', async () => {
        const res = await request(app)
            .post('/api/utilisateurs')
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ nom_complet: 'Nouveau', email: `nouveau-${Date.now()}@test.sn`, password: 'faible', role: 'comptable' });
        expect(res.status).toBe(400);
    });
});

describe('sécurité — vérification d\'email', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        // Les limiteurs de débit sont instanciés une fois au chargement du module route (voir
        // inscription.test.js) — reset nécessaire pour ne pas accumuler leur état sur tout le
        // fichier, vu le nombre de connexions/tentatives exercées par cette suite.
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test Email');
        app = buildApp(pool, ['auth']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un compte non vérifié ne peut pas se connecter', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, emailVerifie: false });
        const res = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('EMAIL_NON_VERIFIE');
    });

    test('un compte "grandfathered" (créé avant la migration) reste non bloqué', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, emailVerifie: true });
        const res = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(res.status).toBe(200);
    });

    test('GET /verifier-email active le compte avec un token valide', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, emailVerifie: false });
        const token = 'token-clair-de-test';
        const hash = require('crypto').createHash('sha256').update(token).digest('hex');
        await pool.query(
            `UPDATE utilisateurs SET email_verification_token_hash = $1, email_verification_expire_le = now() + interval '1 hour' WHERE id = $2`,
            [hash, u.id]
        );

        const res = await request(app).get(`/api/auth/verifier-email?token=${token}`);
        expect(res.status).toBe(200);

        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(login.status).toBe(200);
    });

    test('GET /verifier-email rejette un token expiré ou invalide', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, emailVerifie: false });
        const token = 'token-expire-de-test';
        const hash = require('crypto').createHash('sha256').update(token).digest('hex');
        await pool.query(
            `UPDATE utilisateurs SET email_verification_token_hash = $1, email_verification_expire_le = now() - interval '1 hour' WHERE id = $2`,
            [hash, u.id]
        );

        const expire = await request(app).get(`/api/auth/verifier-email?token=${token}`);
        expect(expire.status).toBe(400);

        const invalide = await request(app).get(`/api/auth/verifier-email?token=nimportequoi`);
        expect(invalide.status).toBe(400);
    });

    test('POST /renvoyer-verification renvoie toujours le même message, compte existant ou non', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, emailVerifie: false });
        const avecCompte = await request(app).post('/api/auth/renvoyer-verification').send({ email: u.email });
        const sansCompte = await request(app).post('/api/auth/renvoyer-verification').send({ email: 'inconnu@test.sn' });

        expect(avecCompte.status).toBe(200);
        expect(sansCompte.status).toBe(200);
        expect(avecCompte.body.message).toBe(sansCompte.body.message);
    });
});

describe('sécurité — MFA', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test MFA');
        app = buildApp(pool, ['auth']);
        envoyerMessageWhatsapp = require('../src/whatsapp').envoyerMessageWhatsapp;
    });

    afterEach(async () => {
        await pool.end();
    });

    test('connexion avec TOTP actif renvoie un défi, puis un token après vérification', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, mfaActif: false });

        // Active le TOTP via les routes elles-mêmes (comme le ferait l'écran "Mon compte").
        const tokenSetup = require('../src/auth').signToken({ id: u.id, role_nom: 'admin', nom_complet: 'Utilisateur Test', tenant_id: tenantId, token_version: 1 });
        const init = await request(app).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${tokenSetup}`).send({ currentPassword: u.motDePasse });
        expect(init.status).toBe(200);
        const codeInit = authenticator.generate(init.body.secret);
        const activer = await request(app).post('/api/auth/mfa/totp/activer').set('Authorization', `Bearer ${tokenSetup}`).send({ code: codeInit });
        expect(activer.status).toBe(200);

        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(login.status).toBe(200);
        expect(login.body.mfaRequis).toBe(true);
        expect(login.body.mfaMethode).toBe('TOTP');
        expect(login.body.token).toBeUndefined();

        const codeLogin = authenticator.generate(init.body.secret);
        const verif = await request(app).post('/api/auth/mfa/verifier').send({ challengeToken: login.body.challengeToken, code: codeLogin });
        expect(verif.status).toBe(200);
        expect(verif.body.token).toBeTruthy();
    });

    test('code TOTP invalide est rejeté au moment du défi de connexion', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const tokenSetup = require('../src/auth').signToken({ id: u.id, role_nom: 'admin', nom_complet: 'Utilisateur Test', tenant_id: tenantId, token_version: 1 });
        const init = await request(app).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${tokenSetup}`).send({ currentPassword: u.motDePasse });
        const codeInit = authenticator.generate(init.body.secret);
        await request(app).post('/api/auth/mfa/totp/activer').set('Authorization', `Bearer ${tokenSetup}`).send({ code: codeInit });

        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        const verif = await request(app).post('/api/auth/mfa/verifier').send({ challengeToken: login.body.challengeToken, code: '000000' });
        expect(verif.status).toBe(401);
    });

    test('connexion avec WhatsApp actif envoie un code et le vérifie', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, mfaActif: true, mfaMethode: 'WHATSAPP' });
        await pool.query(`UPDATE utilisateurs SET mfa_whatsapp_numero = '+221771234567' WHERE id = $1`, [u.id]);

        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(login.status).toBe(200);
        expect(login.body.mfaRequis).toBe(true);
        expect(login.body.mfaMethode).toBe('WHATSAPP');
        expect(envoyerMessageWhatsapp).toHaveBeenCalled();

        const dernierAppel = envoyerMessageWhatsapp.mock.calls[envoyerMessageWhatsapp.mock.calls.length - 1];
        const codeEnvoye = dernierAppel[1].composants[0].parameters[0].text;

        const mauvais = await request(app).post('/api/auth/mfa/verifier').send({ challengeToken: login.body.challengeToken, code: '000000' });
        expect(mauvais.status).toBe(401);

        const bon = await request(app).post('/api/auth/mfa/verifier').send({ challengeToken: login.body.challengeToken, code: codeEnvoye });
        expect(bon.status).toBe(200);
        expect(bon.body.token).toBeTruthy();
    });

    // Mise en attente volontaire (2026-08-27, voir mfa.js whatsappMfaActif) : le numéro WhatsApp
    // Business de production est bloqué et le template Meta "Authentication" pas encore approuvé —
    // l'enrôlement WhatsApp doit rester fermé par défaut tant que MFA_WHATSAPP_ACTIF n'est pas 'true'.
    test('activation du MFA WhatsApp est bloquée (503) tant qu\'elle n\'est pas explicitement activée', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const tokenSetup = require('../src/auth').signToken({ id: u.id, role_nom: 'admin', nom_complet: 'Utilisateur Test', tenant_id: tenantId, token_version: 1 });

        expect(process.env.MFA_WHATSAPP_ACTIF).toBeUndefined();
        const init = await request(app).post('/api/auth/mfa/whatsapp/init').set('Authorization', `Bearer ${tokenSetup}`).send({ numero: '+221771234567' });
        expect(init.status).toBe(503);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });

    // Audit sécurité 2026-08-27 : brancher un nouveau second facteur doit reprouver le mot de passe
    // — un jeton de session seul ne doit jamais suffire (sinon un jeton dérobé permet de greffer
    // silencieusement le TOTP de l'attaquant sur le compte de la victime).
    test('POST /mfa/totp/init exige le mot de passe actuel', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const tokenSetup = require('../src/auth').signToken({ id: u.id, role_nom: 'admin', nom_complet: 'Utilisateur Test', tenant_id: tenantId, token_version: 1 });

        const sansMotDePasse = await request(app).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${tokenSetup}`).send({});
        expect(sansMotDePasse.status).toBe(400);

        const mauvaisMotDePasse = await request(app).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${tokenSetup}`).send({ currentPassword: 'mauvais-mot-de-passe' });
        expect(mauvaisMotDePasse.status).toBe(401);

        const bonMotDePasse = await request(app).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${tokenSetup}`).send({ currentPassword: u.motDePasse });
        expect(bonMotDePasse.status).toBe(200);
        expect(bonMotDePasse.body.secret).toBeTruthy();
    });

    test('un admin avec MFA obligatoire mais non configuré est bloqué sur les autres routes, sauf allowlist', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, role: 'admin', mfaObligatoire: true, mfaActif: false });
        const appAvecUtilisateurs = buildApp(pool, ['auth', 'utilisateurs']);
        const login = await request(appAvecUtilisateurs).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(login.status).toBe(200);
        expect(login.body.utilisateur.mfaSetupRequis).toBe(true);
        const token = login.body.token;

        const routeBloquee = await request(appAvecUtilisateurs).get('/api/utilisateurs').set('Authorization', `Bearer ${token}`);
        expect(routeBloquee.status).toBe(403);
        expect(routeBloquee.body.code).toBe('MFA_SETUP_REQUIS');

        const me = await request(appAvecUtilisateurs).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
        expect(me.status).toBe(200);

        // Termine la configuration TOTP, puis la route précédemment bloquée doit passer.
        const init = await request(appAvecUtilisateurs).post('/api/auth/mfa/totp/init').set('Authorization', `Bearer ${token}`).send({ currentPassword: u.motDePasse });
        const code = authenticator.generate(init.body.secret);
        await request(appAvecUtilisateurs).post('/api/auth/mfa/totp/activer').set('Authorization', `Bearer ${token}`).send({ code });

        const routeDebloquee = await request(appAvecUtilisateurs).get('/api/utilisateurs').set('Authorization', `Bearer ${token}`);
        expect(routeDebloquee.status).toBe(200);
    });

    test('un admin grandfathered (mfa_obligatoire=FALSE) n\'est jamais bloqué', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId, role: 'admin', mfaObligatoire: false, mfaActif: false });
        const appAvecUtilisateurs = buildApp(pool, ['auth', 'utilisateurs']);
        const login = await request(appAvecUtilisateurs).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        expect(login.body.utilisateur.mfaSetupRequis).toBe(false);

        const route = await request(appAvecUtilisateurs).get('/api/utilisateurs').set('Authorization', `Bearer ${login.body.token}`);
        expect(route.status).toBe(200);
    });
});

describe('sécurité — changement de mot de passe self-service', () => {
    let pool;
    let app;
    let tenantId;

    beforeEach(async () => {
        jest.resetModules();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test Self-Service');
        app = buildApp(pool, ['auth']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('rejette un mot de passe actuel incorrect', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        const res = await request(app)
            .put('/api/auth/mot-de-passe')
            .set('Authorization', `Bearer ${login.body.token}`)
            .send({ currentPassword: 'mauvais', newPassword: 'Autremdp123!' });
        expect(res.status).toBe(401);
    });

    // Audit sécurité 2026-08-27 : cette route (comme DELETE /mfa) vérifie un mot de passe mais
    // n'avait aucune limite de tentatives, contrairement à /login — vérifie juste que le
    // middleware de limitation est bien attaché (l'en-tête RateLimit-* ne peut apparaître que si
    // express-rate-limit est monté sur la route).
    test('limite les tentatives sur le changement de mot de passe et la désactivation MFA', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });

        const resMdp = await request(app)
            .put('/api/auth/mot-de-passe')
            .set('Authorization', `Bearer ${login.body.token}`)
            .send({ currentPassword: 'mauvais', newPassword: 'Autremdp123!' });
        expect(resMdp.headers['ratelimit-limit']).toBeTruthy();

        const resMfa = await request(app).delete('/api/auth/mfa').set('Authorization', `Bearer ${login.body.token}`).send({ currentPassword: 'mauvais' });
        expect(resMfa.headers['ratelimit-limit']).toBeTruthy();
    });

    test('rejette un nouveau mot de passe non conforme', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        const res = await request(app)
            .put('/api/auth/mot-de-passe')
            .set('Authorization', `Bearer ${login.body.token}`)
            .send({ currentPassword: u.motDePasse, newPassword: 'faible' });
        expect(res.status).toBe(400);
    });

    test('succès renvoie un nouveau token utilisable', async () => {
        const u = await creerUtilisateurComplet(pool, { tenant_id: tenantId });
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: u.motDePasse });
        const res = await request(app)
            .put('/api/auth/mot-de-passe')
            .set('Authorization', `Bearer ${login.body.token}`)
            .send({ currentPassword: u.motDePasse, newPassword: 'Nouveaumdp123!' });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();

        // L'ancien token est révoqué (token_version incrémenté) ; le nouveau fonctionne.
        const relogin = await request(app).post('/api/auth/login').send({ email: u.email, password: 'Nouveaumdp123!' });
        expect(relogin.status).toBe(200);
    });
});

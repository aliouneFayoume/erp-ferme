// Correctifs d'audit sécurité (authentification) : contournement MFA par code WhatsApp, compteur d'essais atomique,
// jeton de défi MFA refusé comme session, verrou TOTP par compte, unicité avant e-mail, ReDoS, temps de réponse,
// déconnexion serveur, plafond d'envoi du MFA WhatsApp.
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');

jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailReinitialisation: jest.fn().mockResolvedValue({}),
    envoyerEmailMotDePasseModifie: jest.fn().mockResolvedValue({}),
}));

const TEL = '+221771110001';
const MDP = 'Motdepasse#2026';

async function creerUtilisateur(pool, { tenant_id, email, mfaActif = false, mfaMethode = null, secret = null } = {}) {
    const role = (await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`)).rows[0].id;
    const hash = await bcrypt.hash(MDP, 4);
    const mail = email || `u-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.sn`;
    const chiffre = secret ? require('../src/credentials').chiffrer(secret) : null;
    const r = await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif, email_verifie, mfa_actif, mfa_methode, mfa_totp_secret_chiffre)
         VALUES ($1, 'Utilisateur Test', $2, $3, $4, TRUE, TRUE, $5, $6, $7) RETURNING id`,
        [tenant_id, mail, hash, role, mfaActif, mfaMethode, chiffre]
    );
    return { id: r.rows[0].id, email: mail };
}

describe('durcissement authentification', () => {
    let pool;
    let app;
    let tenantId;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Durcie');
        app = buildApp(pool, ['auth', 'essai', 'contact']);
        require('../src/whatsapp').envoyerMessageWhatsapp.mockClear();
    });
    afterEach(async () => {
        process.env = { ...ancienEnv };
        jest.restoreAllMocks();
        await pool.end();
    });

    const dernierCode = () => {
        const appels = require('../src/whatsapp').envoyerMessageWhatsapp.mock.calls;
        return appels[appels.length - 1][1].composants[0].parameters[0].text;
    };
    const signer = (u, extra = {}) =>
        require('../src/auth').signToken({ id: u.id, role_nom: 'admin', nom_complet: 'Utilisateur Test', tenant_id: tenantId, token_version: 1, ...extra });

    // --- 1. Essai autonome : le code WhatsApp ne contourne pas le MFA ---------------------------------------
    describe('essai autonome et double authentification', () => {
        test('/verifier refuse (403) la connexion par code seul quand le MFA est actif', async () => {
            await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme MFA', telephone: TEL });
            const code = dernierCode();
            await pool.query(`UPDATE utilisateurs SET mfa_actif = TRUE, mfa_methode = 'TOTP' WHERE telephone = $1`, [TEL]);
            const res = await request(app).post('/api/essai/verifier').send({ telephone: TEL, code });
            expect(res.status).toBe(403);
            expect(res.body.token).toBeUndefined();
            expect(res.body.erreur).toMatch(/mot de passe/i);
        });

        test('/code n\'envoie aucun code à un compte MFA, avec la même réponse qu\'un compte ordinaire', async () => {
            await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme MFA', telephone: TEL });
            const ordinaire = await request(app).post('/api/essai/code').send({ telephone: TEL });
            await pool.query(`UPDATE utilisateurs SET mfa_actif = TRUE, mfa_methode = 'TOTP', login_code_envoye_le = NULL WHERE telephone = $1`, [TEL]);
            require('../src/whatsapp').envoyerMessageWhatsapp.mockClear();
            const mfa = await request(app).post('/api/essai/code').send({ telephone: TEL });
            expect(mfa.status).toBe(202);
            expect(mfa.body).toEqual(ordinaire.body);
            expect(require('../src/whatsapp').envoyerMessageWhatsapp).not.toHaveBeenCalled();
        });
    });

    // --- 2. Compteur de tentatives atomique ------------------------------------------------------------------
    test('essai autonome : des essais simultanés ne dépassent jamais le plafond du compteur', async () => {
        await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme Course', telephone: TEL });
        const bon = dernierCode();
        const faux = bon === '111111' ? '222222' : '111111';
        const reponses = await Promise.all(Array.from({ length: 8 }, () => request(app).post('/api/essai/verifier').send({ telephone: TEL, code: faux })));
        expect(reponses.every((r) => r.status === 401)).toBe(true);
        const { MAX_TENTATIVES_CODE } = require('../src/essaiAutonome');
        const ligne = (await pool.query(`SELECT login_code_tentatives, login_code_hash FROM utilisateurs WHERE telephone = $1`, [TEL])).rows[0];
        expect(ligne.login_code_tentatives).toBe(MAX_TENTATIVES_CODE);
        expect(ligne.login_code_hash).toBeNull();
        // Code détruit : même le bon code ne passe plus.
        expect((await request(app).post('/api/essai/verifier').send({ telephone: TEL, code: bon })).status).toBe(401);
    });

    // --- 3. requireAuth refuse un jeton de défi MFA ---------------------------------------------------------
    describe('requireAuth', () => {
        test('un jeton de défi MFA n\'ouvre pas une route authentifiée', async () => {
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const defi = jwt.sign({ id: u.id, mfaChallenge: true, tokenVersion: 1, tenant_id: tenantId, role: 'admin' }, require('../src/auth').JWT_SECRET, { expiresIn: '5m' });
            const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${defi}`);
            expect(res.status).toBe(401);
        });

        test('le vrai jeton de défi émis par /login n\'ouvre pas non plus /me', async () => {
            const secret = authenticator.generateSecret();
            const u = await creerUtilisateur(pool, { tenant_id: tenantId, mfaActif: true, mfaMethode: 'TOTP', secret });
            const login = await request(app).post('/api/auth/login').send({ email: u.email, password: MDP });
            const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.challengeToken}`);
            expect(res.status).toBe(401);
        });

        test('un jeton sans tenant_id est refusé', async () => {
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const sansTenant = jwt.sign({ id: u.id, role: 'admin', tokenVersion: 1 }, require('../src/auth').JWT_SECRET, { expiresIn: '5m' });
            const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${sansTenant}`);
            expect(res.status).toBe(401);
        });

        test('un jeton de session normal passe toujours', async () => {
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${signer(u)}`);
            expect(res.status).toBe(200);
        });
    });

    // --- 4. Verrou TOTP par compte --------------------------------------------------------------------------
    describe('verrou TOTP par compte', () => {
        async function compteTotp() {
            const secret = authenticator.generateSecret();
            const u = await creerUtilisateur(pool, { tenant_id: tenantId, mfaActif: true, mfaMethode: 'TOTP', secret });
            const verifier = async (code) => {
                // Nouveau jeton de défi à chaque appel : l'attaquant peut en obtenir autant qu'il veut avec le mot de passe.
                const login = await request(app).post('/api/auth/login').send({ email: u.email, password: MDP });
                return request(app).post('/api/auth/mfa/verifier').send({ challengeToken: login.body.challengeToken, code });
            };
            return { u, secret, verifier };
        }

        test('après 5 échecs, même le bon code est refusé (429) jusqu\'à l\'expiration du verrou', async () => {
            const { u, secret, verifier } = await compteTotp();
            for (let i = 0; i < 5; i++) expect((await verifier('000000')).status).toBe(401);
            const bloque = await verifier(authenticator.generate(secret));
            expect(bloque.status).toBe(429);
            expect(bloque.body.erreur).toMatch(/15 minutes/);
            // Verrou expiré : la connexion repasse.
            await pool.query(`UPDATE utilisateurs SET mfa_code_expire_le = now() - interval '1 minute' WHERE id = $1`, [u.id]);
            const ok = await verifier(authenticator.generate(secret));
            expect(ok.status).toBe(200);
            expect(ok.body.token).toBeTruthy();
        });

        test('un succès remet le compteur à zéro', async () => {
            const { u, secret, verifier } = await compteTotp();
            for (let i = 0; i < 3; i++) await verifier('000000');
            expect((await verifier(authenticator.generate(secret))).status).toBe(200);
            const ligne = (await pool.query(`SELECT mfa_code_tentatives FROM utilisateurs WHERE id = $1`, [u.id])).rows[0];
            expect(ligne.mfa_code_tentatives).toBe(0);
        });
    });

    // --- 5. Unicité de l'adresse avant l'e-mail --------------------------------------------------------------
    test('/securiser-compte : adresse déjà prise = 409 sans qu\'aucun e-mail ne parte', async () => {
        await creerUtilisateur(pool, { tenant_id: tenantId, email: 'prise@ferme.sn' });
        await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme Essai', telephone: TEL });
        const verif = await request(app).post('/api/essai/verifier').send({ telephone: TEL, code: dernierCode() });
        const emailService = require('../src/email');
        emailService.envoyerEmailVerification.mockClear();
        const res = await request(app).post('/api/auth/securiser-compte').set('Authorization', `Bearer ${verif.body.token}`).send({ email: 'Prise@Ferme.sn', password: MDP });
        expect(res.status).toBe(409);
        expect(emailService.envoyerEmailVerification).not.toHaveBeenCalled();
    });

    // --- 6. ReDoS ---------------------------------------------------------------------------------------------
    describe('expressions régulières d\'e-mail linéaires', () => {
        const pathologique = `a@${'.'.repeat(90000)}`;

        test('emailFarfelue refuse une entrée de 90 000 points en moins de 200 ms', () => {
            const { emailFarfelue } = require('../src/validation');
            const t = Date.now();
            expect(emailFarfelue(pathologique)).toBe(true);
            expect(Date.now() - t).toBeLessThan(200);
        });

        test('/contact refuse une entrée de 90 000 points en moins de 200 ms', async () => {
            const t = Date.now();
            const res = await request(app).post('/api/contact').send({ nom: 'Test', email: pathologique, whatsapp: '+221771234567' });
            expect(res.status).toBe(400);
            expect(Date.now() - t).toBeLessThan(200);
        });

        test('/securiser-compte refuse une entrée de 90 000 points en moins de 200 ms', async () => {
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const t = Date.now();
            const res = await request(app).post('/api/auth/securiser-compte').set('Authorization', `Bearer ${signer(u)}`).send({ email: pathologique, password: MDP });
            expect(res.status).toBe(400);
            expect(Date.now() - t).toBeLessThan(200);
        });

        test('les adresses ordinaires restent acceptées', () => {
            const { emailFarfelue } = require('../src/validation');
            expect(emailFarfelue('marie.diop@gmail.com')).toBe(false);
            expect(emailFarfelue('contact@ferme-du-sine.sn')).toBe(false);
            expect(emailFarfelue('a@b')).toBe(true);
        });
    });

    // --- 7. Énumération par temps de réponse -----------------------------------------------------------------
    describe('temps de réponse', () => {
        test('/login exécute un bcrypt.compare même pour un e-mail inconnu', async () => {
            const espion = jest.spyOn(require('bcryptjs'), 'compare'); // instance rechargée par jest.resetModules, celle de la route
            const res = await request(app).post('/api/auth/login').send({ email: 'inconnu@nulle-part.sn', password: MDP });
            expect(res.status).toBe(401);
            expect(res.body.erreur).toBe('Identifiants incorrects.');
            expect(espion).toHaveBeenCalledTimes(1);
        });

        test('/mot-de-passe-oublie ne fait pas attendre la réponse par l\'envoi de l\'e-mail', async () => {
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const emailService = require('../src/email');
            let liberer;
            emailService.envoyerEmailReinitialisation.mockImplementation(() => new Promise((resolve) => { liberer = resolve; }));
            const res = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: u.email });
            expect(res.status).toBe(200);
            expect(emailService.envoyerEmailReinitialisation).toHaveBeenCalledTimes(1);
            liberer({});
        });
    });

    // --- 8. Déconnexion ---------------------------------------------------------------------------------------
    test('POST /deconnexion invalide le jeton et trace LOGOUT', async () => {
        const u = await creerUtilisateur(pool, { tenant_id: tenantId });
        const jeton = signer(u);
        const res = await request(app).post('/api/auth/deconnexion').set('Authorization', `Bearer ${jeton}`).send({});
        expect(res.status).toBe(200);
        expect((await pool.query(`SELECT token_version FROM utilisateurs WHERE id = $1`, [u.id])).rows[0].token_version).toBe(2);
        const audit = await pool.query(`SELECT * FROM audit_logs WHERE action = 'LOGOUT' AND utilisateur_id = $1`, [u.id]);
        expect(audit.rows).toHaveLength(1);
        expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${jeton}`)).status).toBe(401);
    });

    test('POST /deconnexion exige une authentification', async () => {
        expect((await request(app).post('/api/auth/deconnexion').send({})).status).toBe(401);
    });

    // --- 9. MFA WhatsApp : numéro valide et plafond d'envois -------------------------------------------------
    describe('/mfa/whatsapp/init', () => {
        test('refuse un numéro invalide', async () => {
            process.env.MFA_WHATSAPP_ACTIF = 'true';
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const res = await request(app).post('/api/auth/mfa/whatsapp/init').set('Authorization', `Bearer ${signer(u)}`).send({ currentPassword: MDP, numero: '12ab' });
            expect(res.status).toBe(400);
            expect(require('../src/whatsapp').envoyerMessageWhatsapp).not.toHaveBeenCalled();
        });

        test('plafonne à 3 envois par compte et par jour', async () => {
            process.env.MFA_WHATSAPP_ACTIF = 'true';
            const u = await creerUtilisateur(pool, { tenant_id: tenantId });
            const envoyer = () => request(app).post('/api/auth/mfa/whatsapp/init').set('Authorization', `Bearer ${signer(u)}`).send({ currentPassword: MDP, numero: '+221771234567' });
            for (let i = 0; i < 3; i++) expect((await envoyer()).status).toBe(200);
            const quatrieme = await envoyer();
            expect(quatrieme.status).toBe(429);
            expect(require('../src/whatsapp').envoyerMessageWhatsapp).toHaveBeenCalledTimes(3);
        });
    });
});

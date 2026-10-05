const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');

// Jamais de vrai appel réseau vers Resend depuis la suite de tests.
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailReinitialisation: jest.fn().mockResolvedValue({}),
    envoyerEmailMotDePasseModifie: jest.fn().mockResolvedValue({}),
}));

const ANCIEN_MOT_DE_PASSE = 'Ancienmotdepasse1!';
const NOUVEAU_MOT_DE_PASSE = 'Nouveaumotdepasse2!';

async function creerUtilisateur(pool, tenantId, overrides = {}) {
    const opts = {
        email: `reset-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.sn`,
        actif: true,
        emailVerifie: true,
        mfaActif: false,
        ...overrides,
    };
    const role = await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`);
    const hash = await bcrypt.hash(ANCIEN_MOT_DE_PASSE, 4);
    const res = await pool.query(
        `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif, email_verifie, mfa_actif, mfa_methode)
         VALUES ($1, 'Awa Diop', $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tenantId, opts.email, hash, role.rows[0].id, opts.actif, opts.emailVerifie, opts.mfaActif, opts.mfaActif ? 'TOTP' : null]
    );
    return { id: res.rows[0].id, email: opts.email };
}

describe('réinitialisation de mot de passe en libre-service', () => {
    let pool;
    let app;
    let email;
    let tenantId;

    beforeEach(async () => {
        // Reset du registre de modules : les rate-limiters sont instanciés au chargement de la route (comme contact.test.js).
        jest.resetModules();
        email = require('../src/email');
        email.estConfigure.mockReturnValue(true);
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Test Reset');
        app = buildApp(pool, ['auth']);
    });

    afterEach(async () => {
        await pool.end();
    });

    /** Demande un lien et renvoie le jeton en clair tel que reçu par e-mail. */
    async function demanderLien(adresse) {
        email.envoyerEmailReinitialisation.mockClear();
        const res = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: adresse });
        expect(res.status).toBe(200);
        return email.envoyerEmailReinitialisation.mock.calls[0]?.[2];
    }

    test('répond le même message que le compte existe ou non, et n\'envoie un e-mail que pour un vrai compte', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const avecCompte = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: u.email });
        const sansCompte = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: 'inconnu@test.sn' });

        expect(avecCompte.status).toBe(200);
        expect(sansCompte.status).toBe(200);
        expect(avecCompte.body.message).toBe(sansCompte.body.message);
        expect(email.envoyerEmailReinitialisation).toHaveBeenCalledTimes(1);
        const [adresse, nom, jeton] = email.envoyerEmailReinitialisation.mock.calls[0];
        expect(adresse).toBe(u.email);
        expect(nom).toBe('Awa Diop');
        expect(jeton).toMatch(/^[0-9a-f]{64}$/);
    });

    test("stocke seulement le hash du jeton, jamais le jeton en clair", async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const jeton = await demanderLien(u.email);

        const ligne = (await pool.query(`SELECT reset_token_hash, reset_expire_le FROM utilisateurs WHERE id = $1`, [u.id])).rows[0];
        expect(ligne.reset_token_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(ligne.reset_token_hash).not.toBe(jeton);
        expect(new Date(ligne.reset_expire_le).getTime()).toBeGreaterThan(Date.now());
    });

    test('exige une adresse e-mail et reconnaît une adresse saisie avec une autre casse', async () => {
        const vide = await request(app).post('/api/auth/mot-de-passe-oublie').send({});
        expect(vide.status).toBe(400);

        const u = await creerUtilisateur(pool, tenantId, { email: 'casse.mixte@test.sn' });
        const jeton = await demanderLien('CASSE.Mixte@Test.sn');
        expect(jeton).toBeDefined();
        expect(email.envoyerEmailReinitialisation.mock.calls[0][0]).toBe(u.email);
    });

    test('ne fait rien pour un compte désactivé ou supprimé', async () => {
        const inactif = await creerUtilisateur(pool, tenantId, { actif: false });
        const supprime = await creerUtilisateur(pool, tenantId);
        await pool.query(`UPDATE utilisateurs SET deleted_at = now() WHERE id = $1`, [supprime.id]);

        await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: inactif.email });
        await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: supprime.email });

        expect(email.envoyerEmailReinitialisation).not.toHaveBeenCalled();
    });

    test("limite à une demande toutes les 2 minutes par compte : la seconde ne renvoie rien et le premier lien reste valable", async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const premier = await demanderLien(u.email);
        email.envoyerEmailReinitialisation.mockClear();
        await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: u.email });

        expect(email.envoyerEmailReinitialisation).not.toHaveBeenCalled();
        const ok = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: premier, newPassword: NOUVEAU_MOT_DE_PASSE });
        expect(ok.status).toBe(200);
    });

    test('un échec d\'envoi de l\'e-mail ne casse pas la réponse (et ne révèle rien)', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        email.envoyerEmailReinitialisation.mockRejectedValueOnce(new Error('Resend indisponible'));
        const res = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: u.email });
        expect(res.status).toBe(200);
    });

    test('le lien change le mot de passe : le nouveau fonctionne, l\'ancien est refusé, une confirmation est envoyée', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const jeton = await demanderLien(u.email);

        const res = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });
        expect(res.status).toBe(200);

        const nouveau = await request(app).post('/api/auth/login').send({ email: u.email, password: NOUVEAU_MOT_DE_PASSE });
        const ancien = await request(app).post('/api/auth/login').send({ email: u.email, password: ANCIEN_MOT_DE_PASSE });
        expect(nouveau.status).toBe(200);
        expect(nouveau.body.token).toBeTruthy();
        expect(ancien.status).toBe(401);
        expect(email.envoyerEmailMotDePasseModifie).toHaveBeenCalledWith(u.email, 'Awa Diop');
    });

    test('le lien est à usage unique', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const jeton = await demanderLien(u.email);

        const premier = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });
        const second = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: 'Autremotdepasse3!' });

        expect(premier.status).toBe(200);
        expect(second.status).toBe(400);
        const ligne = (await pool.query(`SELECT reset_token_hash, reset_expire_le FROM utilisateurs WHERE id = $1`, [u.id])).rows[0];
        expect(ligne.reset_token_hash).toBeNull();
        expect(ligne.reset_expire_le).toBeNull();
    });

    test('refuse un mot de passe non conforme sans consommer le lien', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const jeton = await demanderLien(u.email);

        const faible = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: 'court' });
        expect(faible.status).toBe(400);
        expect(faible.body.erreur).toMatch(/mot de passe doit contenir/i);

        const ok = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });
        expect(ok.status).toBe(200);
    });

    test('refuse un lien inconnu, expiré, ou une requête incomplète', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const jeton = await demanderLien(u.email);

        const inconnu = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: 'f'.repeat(64), newPassword: NOUVEAU_MOT_DE_PASSE });
        const incomplet = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton });
        await pool.query(`UPDATE utilisateurs SET reset_expire_le = now() - interval '1 minute' WHERE id = $1`, [u.id]);
        const expire = await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });

        expect(inconnu.status).toBe(400);
        expect(incomplet.status).toBe(400);
        expect(expire.status).toBe(400);
        expect(expire.body.erreur).toMatch(/invalide ou expiré/i);
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: ANCIEN_MOT_DE_PASSE });
        expect(login.status).toBe(200); // l'ancien mot de passe n'a pas bougé
    });

    test('invalide les sessions ouvertes : un ancien jeton de connexion ne marche plus', async () => {
        const u = await creerUtilisateur(pool, tenantId);
        const session = await request(app).post('/api/auth/login').send({ email: u.email, password: ANCIEN_MOT_DE_PASSE });
        expect(session.status).toBe(200);
        const avant = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${session.body.token}`);
        expect(avant.status).toBe(200);

        const jeton = await demanderLien(u.email);
        await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });

        const apres = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${session.body.token}`);
        expect(apres.status).toBe(401);
    });

    test("ne contourne pas la double authentification : le second facteur reste exigé après la réinitialisation", async () => {
        const u = await creerUtilisateur(pool, tenantId, { mfaActif: true });
        const jeton = await demanderLien(u.email);
        await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });

        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: NOUVEAU_MOT_DE_PASSE });
        expect(login.status).toBe(200);
        expect(login.body.mfaRequis).toBe(true);
        expect(login.body.token).toBeUndefined();
    });

    test("cliquer le lien prouve la boîte mail : un compte non vérifié le devient", async () => {
        const u = await creerUtilisateur(pool, tenantId, { emailVerifie: false });
        const jeton = await demanderLien(u.email);
        await request(app).post('/api/auth/reinitialiser-mot-de-passe').send({ token: jeton, newPassword: NOUVEAU_MOT_DE_PASSE });

        const ligne = (await pool.query(`SELECT email_verifie FROM utilisateurs WHERE id = $1`, [u.id])).rows[0];
        expect(ligne.email_verifie).toBe(true);
        const login = await request(app).post('/api/auth/login').send({ email: u.email, password: NOUVEAU_MOT_DE_PASSE });
        expect(login.status).toBe(200);
    });
});

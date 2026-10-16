const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs } = require('./helpers/testApp');

// Jamais de vrai appel à l'API Meta depuis la suite (voir whatsapp.test.js, mfa) : on intercepte l'envoi et on lit le code
// qu'il aurait transmis.
jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

const TEL = '+221771112233';

/** Code à 6 chiffres transmis par le dernier envoi WhatsApp intercepté. */
function dernierCodeEnvoye() {
    const { envoyerMessageWhatsapp } = require('../src/whatsapp');
    const appels = envoyerMessageWhatsapp.mock.calls;
    const options = appels[appels.length - 1][1];
    return options.composants[0].parameters[0].text;
}

describe('essai autonome — inscription par téléphone et connexion par code WhatsApp', () => {
    let pool;
    let app;
    const ancienEnv = { ...process.env };

    beforeEach(async () => {
        // Les limiteurs de débit sont instanciés au chargement du module de route : remise à zéro par test (voir inscription.test.js).
        jest.resetModules();
        process.env.ESSAI_AUTONOME_ACTIF = 'true';
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['essai', 'production']);
    });

    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    async function ouvrirEssai(overrides = {}) {
        const res = await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme du Test', telephone: TEL, ...overrides });
        expect(res.status).toBe(202);
        return dernierCodeEnvoye();
    }

    async function connecter(code = null) {
        const res = await request(app).post('/api/essai/verifier').send({ telephone: TEL, code: code || dernierCodeEnvoye() });
        return res;
    }

    test("fermé par défaut : tant que l'interrupteur n'est pas levé, rien ne s'ouvre", async () => {
        delete process.env.ESSAI_AUTONOME_ACTIF;
        expect((await request(app).get('/api/essai/disponible')).body).toEqual({ disponible: false });
        const res = await request(app).post('/api/essai/inscription').send({ nomFerme: 'Ferme X', telephone: TEL });
        expect(res.status).toBe(503);
        const orgs = await pool.query('SELECT COUNT(*)::int AS n FROM organisations');
        expect(orgs.rows[0].n).toBe(0);
    });

    test("fermé aussi sans modèle Meta « Authentication » (aucun code ne pourrait partir)", async () => {
        delete process.env.WHATSAPP_TEMPLATE_AUTH_NOM;
        expect((await request(app).get('/api/essai/disponible')).body).toEqual({ disponible: false });
    });

    test("l'inscription crée la ferme d'essai : abonnement ESSAI de 30 jours, gérant sans e-mail, ferme démo", async () => {
        await ouvrirEssai({ source: 'demo' });

        const org = await pool.query('SELECT id, nom FROM organisations');
        expect(org.rows).toHaveLength(1);
        expect(org.rows[0].nom).toBe('Ferme du Test');

        const abo = (await pool.query('SELECT * FROM organisation_abonnement_saas')).rows[0];
        expect(abo.plan).toBe('ESSAI');
        expect(abo.source_inscription).toBe('demo');
        expect(Number(abo.montant_mensuel)).toBe(0);
        const jours = (new Date(abo.essai_fin_le) - new Date(abo.essai_debut_le)) / 86400000;
        expect(Math.round(jours)).toBe(30);

        const user = (await pool.query('SELECT * FROM utilisateurs')).rows[0];
        expect(user.email).toBeNull();
        expect(user.telephone).toBe(TEL);
        expect(user.telephone_verifie).toBe(false); // pas encore prouvé : le code n'a pas été saisi
        expect(user.mfa_obligatoire).toBe(false);
        expect(user.mot_de_passe_hash).toBeTruthy();

        // Ferme démo : un lot TERMINÉ marqué démo, avec 42 jours de relevés, mortalité totale réaliste (~3 %)
        const lot = (await pool.query('SELECT * FROM lots_production')).rows[0];
        expect(lot.est_demo).toBe(true);
        expect(lot.statut).toBe('TERMINE');
        expect(lot.quantite_initiale).toBe(2000);
        const releves = await pool.query('SELECT COUNT(*)::int AS n, SUM(mortalite)::int AS morts FROM releves_journaliers WHERE lot_id = $1', [lot.id]);
        expect(releves.rows[0].n).toBe(42);
        expect(releves.rows[0].morts).toBeGreaterThan(40);
        expect(releves.rows[0].morts).toBeLessThan(90);
    });

    test('le code part par WhatsApp avec le modèle « Authentication » (corps ET bouton)', async () => {
        await ouvrirEssai();
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        expect(envoyerMessageWhatsapp).toHaveBeenCalledTimes(1);
        const [numero, options] = envoyerMessageWhatsapp.mock.calls[0];
        expect(numero).toBe(TEL);
        expect(options.modele).toEqual({ nom: 'code_connexion_massla', langue: 'fr' });
        const code = options.composants[0].parameters[0].text;
        expect(code).toMatch(/^\d{6}$/);
        expect(options.composants[1]).toEqual({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
    });

    test('le bon code ouvre une session : le numéro devient vérifié, le code est consommé', async () => {
        await ouvrirEssai();
        const res = await connecter();
        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.utilisateur).toMatchObject({ role: 'admin', organisation_nom: 'Ferme du Test', telephone: TEL, mfaSetupRequis: false });

        const user = (await pool.query('SELECT telephone_verifie, login_code_hash FROM utilisateurs')).rows[0];
        expect(user.telephone_verifie).toBe(true);
        expect(user.login_code_hash).toBeNull();

        // À usage unique : le même code ne rouvre pas de session
        expect((await connecter(res.body && dernierCodeEnvoye())).status).toBe(401);
    });

    test("la session d'essai fonctionne tout de suite : pas de MFA imposé, la démo ne compte pas comme lot en cours", async () => {
        await ouvrirEssai();
        const token = (await connecter()).body.token;

        const lots = await request(app).get('/api/production/lots').set('Authorization', `Bearer ${token}`);
        expect(lots.status).toBe(200);
        expect(lots.body).toHaveLength(1);
        expect(lots.body[0]).toMatchObject({ est_demo: true, statut: 'TERMINE' });

        const secteur = (await pool.query(`SELECT id FROM secteurs WHERE nom = 'Avicole' AND tenant_id IS NOT NULL`)).rows[0];
        const creer = (code) =>
            request(app)
                .post('/api/production/lots')
                .set('Authorization', `Bearer ${token}`)
                .send({ secteur_id: secteur.id, code_lot: code, quantite_initiale: 500, date_demarrage: '2026-10-01' });
        // Premier vrai lot : accepté (la démo, terminée, n'occupe pas la place) ; second : limite de l'essai
        expect((await creer('A-1')).status).toBe(201);
        const second = await creer('A-2');
        expect(second.status).toBe(402);
        expect(second.body.code).toBe('ESSAI_LIMITE_LOTS');
    });

    test('la démo se supprime en un clic sans toucher aux vrais lots', async () => {
        await ouvrirEssai();
        const token = (await connecter()).body.token;
        const secteur = (await pool.query(`SELECT id FROM secteurs WHERE nom = 'Avicole' AND tenant_id IS NOT NULL`)).rows[0];
        const creation = await request(app)
            .post('/api/production/lots')
            .set('Authorization', `Bearer ${token}`)
            .send({ secteur_id: secteur.id, code_lot: 'REEL-1', quantite_initiale: 500, date_demarrage: '2026-10-01' });
        expect(creation.status).toBe(201);

        const del = await request(app).delete('/api/essai/demo').set('Authorization', `Bearer ${token}`);
        expect(del.status).toBe(200);
        expect(del.body.supprimes).toBe(1);

        const lots = await request(app).get('/api/production/lots').set('Authorization', `Bearer ${token}`);
        expect(lots.body.map((l) => l.code_lot)).toEqual(['REEL-1']);
    });

    test('un mauvais code est refusé, et après 5 essais le code est détruit', async () => {
        const bon = await ouvrirEssai();
        const faux = bon === '000000' ? '111111' : '000000';
        for (let i = 0; i < 5; i += 1) {
            expect((await connecter(faux)).status).toBe(401);
        }
        // Même le bon code est désormais refusé : il faut en redemander un
        expect((await connecter(bon)).status).toBe(401);
    });

    test('un code expiré est refusé', async () => {
        const code = await ouvrirEssai();
        await pool.query(`UPDATE utilisateurs SET login_code_expire_le = now() - interval '1 minute'`);
        expect((await connecter(code)).status).toBe(401);
    });

    test('un numéro inconnu reçoit exactement les mêmes réponses (aucune énumération) et aucun message ne part', async () => {
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        const demande = await request(app).post('/api/essai/code').send({ telephone: '+221780000000' });
        expect(demande.status).toBe(202);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();

        const verif = await request(app).post('/api/essai/verifier').send({ telephone: '+221780000000', code: '123456' });
        expect(verif.status).toBe(401);
        expect(verif.body.erreur).toMatch(/Code incorrect ou expiré/);
    });

    test('redemander un code dans la minute ne renvoie pas de second message', async () => {
        await ouvrirEssai();
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        const res = await request(app).post('/api/essai/code').send({ telephone: TEL });
        expect(res.status).toBe(202);
        expect(envoyerMessageWhatsapp).toHaveBeenCalledTimes(1);

        // Après le délai de renvoi, un nouveau code part
        await pool.query(`UPDATE utilisateurs SET login_code_envoye_le = now() - interval '2 minutes'`);
        await request(app).post('/api/essai/code').send({ telephone: TEL });
        expect(envoyerMessageWhatsapp).toHaveBeenCalledTimes(2);
    });

    test("s'inscrire avec un numéro déjà connu n'ouvre pas une seconde ferme : un code de connexion part simplement", async () => {
        await ouvrirEssai();
        await pool.query(`UPDATE utilisateurs SET login_code_envoye_le = now() - interval '2 minutes'`);
        await ouvrirEssai({ nomFerme: 'Autre nom' });
        const orgs = await pool.query('SELECT nom FROM organisations');
        expect(orgs.rows.map((o) => o.nom)).toEqual(['Ferme du Test']);
    });

    test('saisies invalides : numéro mal formé, nom de ferme vide ou contenant du HTML', async () => {
        const bad = (corps) => request(app).post('/api/essai/inscription').send(corps);
        expect((await bad({ nomFerme: 'Ferme', telephone: 'abc' })).status).toBe(400);
        expect((await bad({ nomFerme: '', telephone: TEL })).status).toBe(400);
        expect((await bad({ nomFerme: '<script>x</script>', telephone: TEL })).status).toBe(400);
        const orgs = await pool.query('SELECT COUNT(*)::int AS n FROM organisations');
        expect(orgs.rows[0].n).toBe(0);
    });

    test("un compte d'essai ne peut jamais se connecter par mot de passe (aucun secret connu)", async () => {
        await ouvrirEssai();
        const bcrypt = require('bcryptjs');
        const user = (await pool.query('SELECT mot_de_passe_hash FROM utilisateurs')).rows[0];
        for (const essai of ['', 'password', 'Motdepasse123!', TEL, 'Ferme du Test']) {
            expect(await bcrypt.compare(essai, user.mot_de_passe_hash)).toBe(false);
        }
    });
});

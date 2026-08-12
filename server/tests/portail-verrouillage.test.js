const request = require('supertest');
const bcrypt = require('bcryptjs');

// Audit sécurité 2026-08-11 (E1) : verrouillage PAR COMPTE sur le portail client, en plus de la
// limite par IP déjà en place (express-rate-limit, 8 tentatives / 15 min) — contournable en
// distribuant les tentatives sur plusieurs IP, ce qui rendait un PIN à 6 chiffres brute-forçable.
//
// Fichier séparé de portail.test.js, et jest.resetModules() à chaque test : le rate-limiter par IP
// de routes/portail.js est un état créé UNE FOIS au chargement du module (limiteurLoginPortail),
// partagé par tous les tests d'un même fichier tant que le module reste en cache. Sans réinitialiser
// le registre de modules Jest entre les tests, les ~5-7 requêtes de login de chaque test
// s'additionneraient et finiraient par heurter la limite par IP (8/15min) au lieu du verrouillage
// par compte que ces tests vérifient réellement.
describe('portail : verrouillage par compte après tentatives échouées', () => {
    let pool, app, creerClient;

    beforeEach(async () => {
        jest.resetModules();
        const testApp = require('./helpers/testApp');
        creerClient = testApp.creerClient;
        pool = testApp.createTestPool();
        await testApp.seedRolesEtSecteurs(pool);
        app = testApp.buildApp(pool, ['portail']);
    });

    afterEach(async () => {
        await pool.end();
    });

    async function definirPin(clientId, pin) {
        const hash = await bcrypt.hash(pin, 10);
        await pool.query(`UPDATE clients SET pin_hash = $1, pin_version = pin_version + 1 WHERE id = $2`, [hash, clientId]);
        return pin;
    }

    test('bloque après 5 mauvais PIN, même avec le bon PIN ensuite', async () => {
        const client = await creerClient(pool, { telephone: '+221770000009' });
        const pin = await definirPin(client.id, '444444');

        for (let i = 0; i < 5; i++) {
            const echec = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin: '000000' });
            expect(echec.status).toBe(i < 4 ? 401 : 429);
        }

        const avecBonPin = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin });
        expect(avecBonPin.status).toBe(429);
    });

    test("le blocage d'un compte ne gêne pas la connexion d'un autre client", async () => {
        const clientBloque = await creerClient(pool, { telephone: '+221770000010' });
        await definirPin(clientBloque.id, '555555');
        for (let i = 0; i < 5; i++) {
            await request(app).post('/api/portail/login').send({ telephone: clientBloque.telephone, pin: '000000' });
        }

        const autreClient = await creerClient(pool, { telephone: '+221770000011' });
        const pinAutre = await definirPin(autreClient.id, '666666');
        const res = await request(app).post('/api/portail/login').send({ telephone: autreClient.telephone, pin: pinAutre });
        expect(res.status).toBe(200);
    });

    test('un login réussi réinitialise le compteur de tentatives', async () => {
        const client = await creerClient(pool, { telephone: '+221770000012' });
        const pin = await definirPin(client.id, '777777');

        await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin: '000000' });
        await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin: '000000' });
        const succes = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin });
        expect(succes.status).toBe(200);

        // Le compteur étant réinitialisé, il faut de nouveau 5 échecs pour bloquer, pas 3.
        for (let i = 0; i < 4; i++) {
            const echec = await request(app).post('/api/portail/login').send({ telephone: client.telephone, pin: '000000' });
            expect(echec.status).toBe(401);
        }
    });
});

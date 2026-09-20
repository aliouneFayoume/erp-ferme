const request = require('supertest');
const { createTestPool, buildApp } = require('./helpers/testApp');

// Jamais de vrai appel réseau vers Resend en test (même principe que inscription.test.js).
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerNotificationContact: jest.fn().mockResolvedValue({}),
}));

function payloadValide(overrides = {}) {
    return {
        nom: 'Clovis Test',
        email: 'clovis@test.sn',
        whatsapp: '+22670000000',
        preference: 'whatsapp',
        ...overrides,
    };
}

describe('contact — formulaire public massla.sn/decouvrir', () => {
    let pool;
    let app;
    let email;

    beforeEach(async () => {
        // Comme inscription.test.js : reset le registre de modules pour isoler le rate-limiter
        // (instancié une seule fois au chargement de la route) entre chaque test. Conséquence :
        // il faut re-require('../src/email') APRÈS le reset pour garder la même référence de mock
        // que celle que contact.js obtient réellement — sinon les assertions portent sur une
        // instance jest.fn() différente de celle effectivement appelée par la route.
        jest.resetModules();
        email = require('../src/email');
        email.estConfigure.mockReturnValue(true);
        pool = createTestPool();
        app = buildApp(pool, ['contact']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('envoie la notification et répond 201 sur un payload valide', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide());

        expect(res.status).toBe(201);
        expect(email.envoyerNotificationContact).toHaveBeenCalledWith({
            nom: 'Clovis Test',
            email: 'clovis@test.sn',
            whatsapp: '+22670000000',
            preference: 'whatsapp',
        });
    });

    test("accepte une demande sans préférence de contact (le formulaire ne la demande plus)", async () => {
        const { preference, ...sansPreference } = payloadValide();
        const res = await request(app).post('/api/contact').send(sansPreference);

        expect(res.status).toBe(201);
        expect(email.envoyerNotificationContact).toHaveBeenCalledWith({
            nom: 'Clovis Test',
            email: 'clovis@test.sn',
            whatsapp: '+22670000000',
            preference: '',
        });
    });

    test('rejette un nom manquant', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ nom: '' }));
        expect(res.status).toBe(400);
        expect(email.envoyerNotificationContact).not.toHaveBeenCalled();
    });

    test('rejette une adresse email invalide', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ email: 'pas-un-email' }));
        expect(res.status).toBe(400);
    });

    test('rejette un numéro WhatsApp manquant', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ whatsapp: '' }));
        expect(res.status).toBe(400);
    });

    test('rejette une préférence de contact hors liste', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ preference: 'pigeon-voyageur' }));
        expect(res.status).toBe(400);
    });

    test("répond 503 si l'intégration email n'est pas configurée, sans jamais appeler l'envoi", async () => {
        email.estConfigure.mockReturnValue(false);
        const res = await request(app).post('/api/contact').send(payloadValide());
        expect(res.status).toBe(503);
        expect(email.envoyerNotificationContact).not.toHaveBeenCalled();
    });

    test("répond 502 si l'envoi échoue côté Resend", async () => {
        email.envoyerNotificationContact.mockRejectedValueOnce(new Error('Resend indisponible'));
        const res = await request(app).post('/api/contact').send(payloadValide());
        expect(res.status).toBe(502);
    });
});

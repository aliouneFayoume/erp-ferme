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

    test('un numéro sénégalais à 9 chiffres sans indicatif est complété en +221', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ whatsapp: '76 220 64 18' }));

        expect(res.status).toBe(201);
        expect(email.envoyerNotificationContact).toHaveBeenCalledWith(expect.objectContaining({ whatsapp: '+221762206418' }));
    });

    test('un numéro avec espaces, points ou tirets est normalisé', async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ whatsapp: '+226 70-00.00 00' }));

        expect(res.status).toBe(201);
        expect(email.envoyerNotificationContact).toHaveBeenCalledWith(expect.objectContaining({ whatsapp: '+22670000000' }));
    });

    test.each(['12345', 'pas un numéro', '0770000000', '+221 7700', '123456789'])('refuse le numéro invalide « %s » avec un message clair', async (numero) => {
        const res = await request(app).post('/api/contact').send(payloadValide({ whatsapp: numero }));

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/indicatif/i);
        expect(email.envoyerNotificationContact).not.toHaveBeenCalled();
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

    test.each([
        'verif@example.com',
        'test@test.com',
        'test-ne-pas-traiter@massla.sn',
        'admin@massla.sn',
        'asdf@gmail.com',
        'aaaaaa@gmail.com',
        'demo@mailinator.com',
        'toto@yopmail.com',
    ])('rejette l\'adresse email farfelue « %s »', async (adresse) => {
        const res = await request(app).post('/api/contact').send(payloadValide({ email: adresse }));

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/adresse/i);
        expect(email.envoyerNotificationContact).not.toHaveBeenCalled();
    });

    test("accepte une adresse email à l'apparence inhabituelle mais légitime (alias de confidentialité type iCloud)", async () => {
        const res = await request(app).post('/api/contact').send(payloadValide({ email: '31-parcourt.ruisselet@icloud.com' }));

        expect(res.status).toBe(201);
        expect(email.envoyerNotificationContact).toHaveBeenCalledWith(expect.objectContaining({ email: '31-parcourt.ruisselet@icloud.com' }));
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

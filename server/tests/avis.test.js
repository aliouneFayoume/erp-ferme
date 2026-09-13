const request = require('supertest');
const { createTestPool, buildApp } = require('./helpers/testApp');

// Jamais de vrai appel réseau vers Resend en test (même principe que contact.test.js).
jest.mock('../src/email', () => ({
    estConfigure: jest.fn().mockReturnValue(true),
    envoyerNotificationAvis: jest.fn().mockResolvedValue({}),
}));

async function creerAvis(pool, overrides = {}) {
    const a = { nom: 'Client Test', nom_ferme: null, note: 5, commentaire: 'Très satisfait.', approuve: false, ...overrides };
    const res = await pool.query(
        `INSERT INTO avis_publics (nom, nom_ferme, note, commentaire, approuve) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [a.nom, a.nom_ferme, a.note, a.commentaire, a.approuve]
    );
    return res.rows[0];
}

function payloadValide(overrides = {}) {
    return {
        nom: 'Clovis Test',
        nomFerme: 'Fish Feed Burkina',
        note: 5,
        commentaire: "Super outil, l'équipe est très réactive.",
        ...overrides,
    };
}

describe('avis — section "Avis clients" du site vitrine', () => {
    let pool;
    let app;
    let email;

    beforeEach(async () => {
        // Comme contact.test.js : reset le registre de modules pour isoler le rate-limiter entre
        // tests, et re-require('../src/email') APRÈS pour garder la même référence de mock que
        // celle que routes/avis.js obtient réellement.
        jest.resetModules();
        email = require('../src/email');
        email.estConfigure.mockReturnValue(true);
        email.envoyerNotificationAvis.mockResolvedValue({});
        pool = createTestPool();
        app = buildApp(pool, ['avis']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('GET ne renvoie que les avis approuvés', async () => {
        await creerAvis(pool, { nom: 'En attente', approuve: false });
        const approuve = await creerAvis(pool, { nom: 'Publié', approuve: true });

        const res = await request(app).get('/api/avis');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe(approuve.id);
        expect(res.body[0].nom).toBe('Publié');
    });

    test('POST crée un avis toujours en attente, même si approuve=true est envoyé par le client', async () => {
        const res = await request(app).post('/api/avis').send({ ...payloadValide(), approuve: true });

        expect(res.status).toBe(201);
        const enBase = await pool.query(`SELECT * FROM avis_publics ORDER BY id DESC LIMIT 1`);
        expect(enBase.rows[0].approuve).toBe(false);
        expect(enBase.rows[0].nom).toBe('Clovis Test');
        expect(enBase.rows[0].note).toBe(5);
    });

    test('rejette un nom manquant', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide({ nom: '' }));
        expect(res.status).toBe(400);
    });

    test('rejette une note hors de la plage 1-5', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide({ note: 6 }));
        expect(res.status).toBe(400);
    });

    test('rejette une note non entière', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide({ note: 3.5 }));
        expect(res.status).toBe(400);
    });

    test('rejette un commentaire manquant', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide({ commentaire: '' }));
        expect(res.status).toBe(400);
    });

    test('accepte un avis sans nom de ferme (champ optionnel)', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide({ nomFerme: undefined }));
        expect(res.status).toBe(201);
    });

    test('la soumission déclenche une notification par email avec un jeton d\'approbation', async () => {
        const res = await request(app).post('/api/avis').send(payloadValide());
        expect(res.status).toBe(201);
        expect(email.envoyerNotificationAvis).toHaveBeenCalledTimes(1);
        const args = email.envoyerNotificationAvis.mock.calls[0][0];
        expect(args.nom).toBe('Clovis Test');
        expect(typeof args.token).toBe('string');
        expect(args.token.length).toBeGreaterThan(20);
    });

    test("l'avis reste enregistré même si l'envoi de la notification échoue", async () => {
        email.envoyerNotificationAvis.mockRejectedValueOnce(new Error('Resend indisponible'));
        const res = await request(app).post('/api/avis').send(payloadValide());
        expect(res.status).toBe(201);
        const enBase = await pool.query(`SELECT * FROM avis_publics ORDER BY id DESC LIMIT 1`);
        expect(enBase.rows).toHaveLength(1);
    });

    describe('GET /approuver — clic depuis l\'email de notification', () => {
        async function soumettreEtRecupererToken(overrides = {}) {
            const res = await request(app).post('/api/avis').send(payloadValide(overrides));
            expect(res.status).toBe(201);
            return email.envoyerNotificationAvis.mock.calls[email.envoyerNotificationAvis.mock.calls.length - 1][0].token;
        }

        test('un jeton valide publie l\'avis', async () => {
            const token = await soumettreEtRecupererToken();

            const res = await request(app).get('/api/avis/approuver').query({ token });
            expect(res.status).toBe(200);

            const enBase = await pool.query(`SELECT approuve, token_approbation_hash FROM avis_publics ORDER BY id DESC LIMIT 1`);
            expect(enBase.rows[0].approuve).toBe(true);
            expect(enBase.rows[0].token_approbation_hash).toBeNull();
        });

        test('un jeton invalide est rejeté', async () => {
            const res = await request(app).get('/api/avis/approuver').query({ token: 'ce-jeton-nexiste-pas' });
            expect(res.status).toBe(400);
        });

        test('un jeton absent est rejeté', async () => {
            const res = await request(app).get('/api/avis/approuver');
            expect(res.status).toBe(400);
        });

        test('un jeton déjà utilisé (lien à usage unique) est rejeté au second clic', async () => {
            const token = await soumettreEtRecupererToken();

            const premier = await request(app).get('/api/avis/approuver').query({ token });
            expect(premier.status).toBe(200);

            const second = await request(app).get('/api/avis/approuver').query({ token });
            expect(second.status).toBe(400);
        });

        test('approuver un avis déjà publié par ailleurs (vue plateforme) reste idempotent', async () => {
            const token = await soumettreEtRecupererToken();
            const enBase = await pool.query(`SELECT id FROM avis_publics ORDER BY id DESC LIMIT 1`);
            await pool.query(`UPDATE avis_publics SET approuve = TRUE WHERE id = $1`, [enBase.rows[0].id]);

            const res = await request(app).get('/api/avis/approuver').query({ token });
            expect(res.status).toBe(200);
            expect(res.body.message).toMatch(/déjà publié/i);
        });
    });
});

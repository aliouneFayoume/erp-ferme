const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

const mockCreerMessage = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Réponse mockée.' }] });
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreerMessage } })));

// Le plafond par ferme (50/jour) borne chaque ferme, mais pas la facture TOTALE : 100 fermes × 50 appels = 5 000 appels/jour.
// Le plafond global (ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL, défaut 500) borne la dépense maximale de la plateforme, toutes fermes confondues.
describe('assistant — plafond quotidien global (toutes fermes confondues)', () => {
    let pool, app, tokenA, tokenB;
    const ancienEnv = { ...process.env };
    const question = { messages: [{ role: 'user', content: 'Comment traiter le mildiou ?' }] };
    const poser = (token) => request(app).post('/api/assistant/chat').set('Authorization', `Bearer ${token}`).send(question);

    beforeEach(async () => {
        jest.resetModules(); // le limiteur par ferme est instancié au chargement du module : un compteur neuf par test
        process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
        mockCreerMessage.mockClear();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        const tenantA = await creerOrganisation(pool, 'Ferme A');
        const tenantB = await creerOrganisation(pool, 'Ferme B');
        tokenA = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantA });
        tokenB = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantB });
        app = buildApp(pool, ['assistant']);
    });

    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    test('au-delà du plafond global, une AUTRE ferme est aussi refusée (429) sans appeler le modèle', async () => {
        process.env.ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL = '2';

        expect((await poser(tokenA)).status).toBe(200);
        expect((await poser(tokenB)).status).toBe(200);
        const refus = await poser(tokenA);
        const refusAutreFerme = await poser(tokenB);

        expect(refus.status).toBe(429);
        expect(refus.body.erreur).toMatch(/plateforme|global|limite/i);
        expect(refusAutreFerme.status).toBe(429);
        expect(mockCreerMessage).toHaveBeenCalledTimes(2);
    });

    test('les appels de plus de 24 h ne comptent plus', async () => {
        process.env.ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL = '1';
        expect((await poser(tokenA)).status).toBe(200);
        await pool.query(`UPDATE audit_logs SET cree_le = now() - interval '25 hours' WHERE table_name = 'assistant'`);
        expect((await poser(tokenB)).status).toBe(200);
    });

    test('valeur invalide de la variable : retour au défaut (500), jamais un plafond à 0 qui bloquerait tout', async () => {
        process.env.ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL = 'abc';
        expect((await poser(tokenA)).status).toBe(200);
        process.env.ASSISTANT_PLAFOND_QUOTIDIEN_GLOBAL = '0';
        expect((await poser(tokenA)).status).toBe(200);
    });

    test('la longueur de la réponse du modèle est plafonnée (max_tokens)', async () => {
        await poser(tokenA);
        const parametres = mockCreerMessage.mock.calls[0][0];
        expect(parametres.max_tokens).toBeGreaterThan(0);
        expect(parametres.max_tokens).toBeLessThanOrEqual(1024);
    });
});

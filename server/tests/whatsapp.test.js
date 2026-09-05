const { envoyerMessageWhatsapp, estConfigure } = require('../src/whatsapp');

describe('whatsapp — envoyerMessageWhatsapp', () => {
    const env = { ...process.env };
    const fetchOriginal = global.fetch;

    afterEach(() => {
        process.env = { ...env };
        global.fetch = fetchOriginal;
        jest.restoreAllMocks();
    });

    test("échoue proprement si l'intégration n'est pas configurée", async () => {
        delete process.env.WHATSAPP_ACCESS_TOKEN;
        delete process.env.WHATSAPP_PHONE_NUMBER_ID;

        await expect(envoyerMessageWhatsapp('+221771234567')).rejects.toThrow('non configurée');
        expect(estConfigure()).toBe(false);
    });

    test('envoie un message template avec les identifiants configurés', async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ messages: [{ id: 'wamid.test' }] }),
        });

        const result = await envoyerMessageWhatsapp('+221 77 123 45 67');

        expect(estConfigure()).toBe(true);
        expect(global.fetch).toHaveBeenCalledWith(
            'https://graph.facebook.com/v21.0/123456/messages',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer faux-jeton' }),
            })
        );
        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.to).toBe('221771234567'); // espaces et + retirés
        expect(bodyEnvoye.template.name).toBe('hello_world'); // défaut avant approbation d'un vrai modèle
        expect(result.messages[0].id).toBe('wamid.test');
    });

    test("propage un message d'erreur clair quand Meta refuse l'envoi", async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'Jeton invalide ou expiré' } }),
        });

        await expect(envoyerMessageWhatsapp('+221771234567')).rejects.toThrow('Jeton invalide ou expiré');
    });

    test('rejette un numéro vide après normalisation', async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        await expect(envoyerMessageWhatsapp('   ')).rejects.toThrow('invalide');
    });

    test('ignore `montant` tant que le modèle de secours "hello_world" est actif (évite un échec Graph API)', async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        // WHATSAPP_TEMPLATE_NOM volontairement absent -> retombe sur hello_world (voir lireConfigGlobale).
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) });

        await envoyerMessageWhatsapp('+221771234567', { montant: 25000 });

        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.template.name).toBe('hello_world');
        expect(bodyEnvoye.template.components).toBeUndefined();
    });

    test('utilise `montant` pour construire les composants une fois un vrai modèle configuré', async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        process.env.WHATSAPP_TEMPLATE_NOM = 'rappel_facture';
        process.env.WHATSAPP_TEMPLATE_LANGUE = 'fr';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) });

        await envoyerMessageWhatsapp('+221771234567', { montant: 25000 });

        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.template.name).toBe('rappel_facture');
        expect(bodyEnvoye.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: '25000' }] }]);
    });

    test('`composants` fourni directement par l\'appelant reste prioritaire sur `montant` (ex. mfa.js)', async () => {
        process.env.WHATSAPP_ACCESS_TOKEN = 'faux-jeton';
        process.env.WHATSAPP_PHONE_NUMBER_ID = '123456';
        // Même sans modèle personnalisé configuré (hello_world), un composants explicite doit passer.
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) });

        await envoyerMessageWhatsapp('+221771234567', { composants: [{ type: 'body', parameters: [{ type: 'text', text: '123456' }] }] });

        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.template.components).toEqual([{ type: 'body', parameters: [{ type: 'text', text: '123456' }] }]);
    });
});

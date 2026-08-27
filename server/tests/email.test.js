const { envoyerEmailVerification, estConfigure } = require('../src/email');

describe('email — envoyerEmailVerification', () => {
    const env = { ...process.env };
    const fetchOriginal = global.fetch;

    afterEach(() => {
        process.env = { ...env };
        global.fetch = fetchOriginal;
        jest.restoreAllMocks();
    });

    test("échoue proprement si l'intégration n'est pas configurée", async () => {
        delete process.env.RESEND_API_KEY;
        delete process.env.RESEND_FROM_EMAIL;

        await expect(envoyerEmailVerification('a@test.sn', 'Test', 'token')).rejects.toThrow('non configurée');
        expect(estConfigure()).toBe(false);
    });

    test('envoie un email avec le lien de vérification et le nom du destinataire', async () => {
        process.env.RESEND_API_KEY = 'faux-jeton';
        process.env.RESEND_FROM_EMAIL = 'ERP Ferme Massla <no-reply@massla.sn>';
        process.env.APP_BASE_URL = 'https://massla.sn';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'email-test' }) });

        await envoyerEmailVerification('user@test.sn', 'Aïssatou Diop', 'le-token-secret');

        expect(estConfigure()).toBe(true);
        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.to).toEqual(['user@test.sn']);
        expect(bodyEnvoye.html).toContain('https://massla.sn/verifier-email.html?token=le-token-secret');
        expect(bodyEnvoye.html).toContain('Aïssatou Diop');
    });

    // Audit sécurité 2026-08-27 : nomComplet est fourni par l'utilisateur (inscription ou création
    // par un admin) — sans échappement, un nom contenant du balisage s'affichait tel quel dans
    // l'email envoyé depuis l'adresse de confiance no-reply@massla.sn (phishing interne).
    test('échappe le HTML dans le nom du destinataire', async () => {
        process.env.RESEND_API_KEY = 'faux-jeton';
        process.env.RESEND_FROM_EMAIL = 'ERP Ferme Massla <no-reply@massla.sn>';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'email-test' }) });

        await envoyerEmailVerification('user@test.sn', '<img src=x onerror=alert(1)>', 'token');

        const bodyEnvoye = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(bodyEnvoye.html).not.toContain('<img src=x onerror=alert(1)>');
        expect(bodyEnvoye.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    test("propage un message d'erreur clair quand Resend refuse l'envoi", async () => {
        process.env.RESEND_API_KEY = 'faux-jeton';
        process.env.RESEND_FROM_EMAIL = 'ERP Ferme Massla <no-reply@massla.sn>';
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Clé API invalide' }) });

        await expect(envoyerEmailVerification('user@test.sn', 'Test', 'token')).rejects.toThrow('Clé API invalide');
    });
});

// Le code MFA par WhatsApp doit partir avec le modèle « Authentication », jamais avec le modèle de relance de facture de la
// config globale (WHATSAPP_TEMPLATE_NOM) — qui l'enverrait à la place d'un montant.
jest.mock('../src/whatsapp', () => ({
    envoyerMessageWhatsapp: jest.fn().mockResolvedValue({}),
    estConfigure: jest.fn(() => true),
}));

describe('mfa — envoi du code par WhatsApp', () => {
    const ancienEnv = { ...process.env };

    beforeEach(() => {
        jest.resetModules();
    });
    afterEach(() => {
        process.env = { ...ancienEnv };
    });

    test('utilise le modèle Authentication, avec le code dans le corps et dans le bouton', async () => {
        process.env.WHATSAPP_TEMPLATE_AUTH_NOM = 'code_connexion_massla';
        const mfa = require('../src/mfa');
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        await mfa.envoyerCodeWhatsapp('+221771112233', '123456');
        const [numero, options] = envoyerMessageWhatsapp.mock.calls[0];
        expect(numero).toBe('+221771112233');
        expect(options.modele).toEqual({ nom: 'code_connexion_massla', langue: 'fr' });
        expect(options.composants[0].parameters[0].text).toBe('123456');
        expect(options.composants[1]).toMatchObject({ type: 'button', sub_type: 'url', index: '0' });
    });

    test("sans modèle Authentication configuré, rien n'est envoyé (jamais le modèle de relance)", async () => {
        delete process.env.WHATSAPP_TEMPLATE_AUTH_NOM;
        const mfa = require('../src/mfa');
        const { envoyerMessageWhatsapp } = require('../src/whatsapp');
        await expect(mfa.envoyerCodeWhatsapp('+221771112233', '123456')).rejects.toThrow(/WHATSAPP_TEMPLATE_AUTH_NOM/);
        expect(envoyerMessageWhatsapp).not.toHaveBeenCalled();
    });
});

const { normaliserTelephone } = require('../src/validation');
const { envoyerNotificationContact } = require('../src/email');

describe('normaliserTelephone — numéro WhatsApp du formulaire de démonstration', () => {
    test.each([
        // Sénégal : 9 chiffres sans indicatif (le cas du 20/09 : 762206418)
        ['762206418', '+221762206418'],
        ['77 000 00 00', '+221770000000'],
        ['70.123.45.67', '+221701234567'],
        ['(78) 123-45-67', '+221781234567'],
        // Sénégal avec indicatif, sous plusieurs formes
        ['+221 77 000 00 00', '+221770000000'],
        ['00221770000000', '+221770000000'],
        ['221 77 000 00 00', '+221770000000'],
        // Fixe sénégalais : accepté seulement avec l'indicatif
        ['+221 33 823 45 67', '+221338234567'],
        // Autres pays : l'indicatif est obligatoire
        ['+226 70 00 00 00', '+22670000000'],
        ['+225 07 12 34 56 78', '+2250712345678'],
        ['+1 416 526 6293', '+14165266293'],
        ['+33 6 12 34 56 78', '+33612345678'],
        ['0033612345678', '+33612345678'],
    ])('%s → %s', (saisie, attendu) => {
        expect(normaliserTelephone(saisie)).toBe(attendu);
    });

    test.each([
        ['vide', ''],
        ['espaces', '   '],
        ['lettres', 'abcdefghi'],
        ['mélange lettres/chiffres', '77 000 00 0a'],
        ['trop court', '12345'],
        ['9 chiffres hors préfixes mobiles sénégalais, sans indicatif', '123456789'],
        ['numéro local à 0 initial sans indicatif', '0770000000'],
        ['+221 avec trop peu de chiffres', '+221 7700'],
        ['+221 avec trop de chiffres', '+221 77 000 00 000'],
        ['indicatif commençant par 0', '+0123456789'],
        ['plus de 15 chiffres', '+1234567890123456'],
        ['caractères interdits', '+221 77 000 00 00 <script>'],
    ])('refuse : %s', (_nom, saisie) => {
        expect(normaliserTelephone(saisie)).toBeNull();
    });

    test('refuse un type autre que texte', () => {
        expect(normaliserTelephone(null)).toBeNull();
        expect(normaliserTelephone(undefined)).toBeNull();
        expect(normaliserTelephone(762206418)).toBeNull();
        expect(normaliserTelephone({ toString: () => '762206418' })).toBeNull();
    });
});

describe("email de notification de contact — lien d'ouverture WhatsApp", () => {
    const env = { ...process.env };
    const fetchOriginal = global.fetch;

    afterEach(() => {
        process.env = { ...env };
        global.fetch = fetchOriginal;
        jest.restoreAllMocks();
    });

    test('affiche le numéro normalisé et un lien wa.me cliquable, sans le +', async () => {
        process.env.RESEND_API_KEY = 'faux-jeton';
        process.env.RESEND_FROM_EMAIL = 'ERP Ferme Massla <no-reply@massla.sn>';
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'email-test' }) });

        await envoyerNotificationContact({ nom: 'Moussa Ba', email: 'moussa@test.sn', whatsapp: '+221762206418' });

        const corps = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(corps.html).toContain('+221762206418');
        expect(corps.html).toContain('href="https://wa.me/221762206418"');
    });
});

const ORIGINE_MASSLA = require('../src/cors-origine');

// Audit sécurité 2026-08-11 (E1) : cors() sans options laissait n'importe quel site web lire les
// réponses de l'API en cross-origin, ce qui rendait le portail client (PIN à 6 chiffres) attaquable
// en brute-force distribué via les navigateurs de visiteurs tiers. Ce test verrouille le
// comportement de la regex utilisée par server/src/index.js pour restreindre l'origine.
describe('regex CORS (cors-origine.js)', () => {
    test.each([
        'https://massla.sn',
        'https://ferme-massla.massla.sn',
        'https://a1-b2.massla.sn',
    ])('autorise %s', (origine) => {
        expect(ORIGINE_MASSLA.test(origine)).toBe(true);
    });

    test.each([
        'http://massla.sn', // pas de HTTPS
        'https://evilmassla.sn', // suffixe sans le point séparateur attendu
        'https://massla.sn.evil.com', // massla.sn en préfixe d'un autre domaine
        'https://massla.com', // mauvais TLD
        'https://sub.sub2.massla.sn', // deux niveaux de sous-domaine, non supporté
        'https://massla.sn/', // trailing slash (jamais présent dans un vrai en-tête Origin, mais on vérifie l'ancre $)
        '',
    ])('rejette %s', (origine) => {
        expect(ORIGINE_MASSLA.test(origine)).toBe(false);
    });
});

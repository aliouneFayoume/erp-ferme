// Nettoyage du code partenaire côté navigateur (web/js/code-partenaire.js). Le fichier est un script global qui s'exporte
// aussi comme module CommonJS : on le teste ici sans jsdom. Le paramètre ?ref= vient de l'URL, donc d'un tiers : il ne doit
// jamais pouvoir transporter autre chose que [A-Z0-9_-], 40 caractères au plus.
const { nettoyerCodePartenaire, CODE_PARTENAIRE_MAX } = require('../../web/js/code-partenaire.js');

describe('nettoyerCodePartenaire', () => {
    test('met en majuscules et retire les espaces', () => {
        expect(nettoyerCodePartenaire('  teranga ')).toBe('TERANGA');
        expect(nettoyerCodePartenaire('ter-anga_2')).toBe('TER-ANGA_2');
    });

    test('supprime tout ce qui pourrait servir à injecter du HTML ou du script', () => {
        expect(nettoyerCodePartenaire('<img src=x onerror=alert(1)>')).toBe('IMGSRCXONERRORALERT1');
        expect(nettoyerCodePartenaire('"><script>alert(1)</script>')).toBe('SCRIPTALERT1SCRIPT');
        expect(nettoyerCodePartenaire('TERANGA&amp;')).toBe('TERANGAAMP');
        expect(nettoyerCodePartenaire("a'b`c%3Cd")).toBe('ABC3CD');
        expect(nettoyerCodePartenaire('é à ü')).toBe('');
    });

    test('longueur plafonnée à 40 caractères', () => {
        expect(CODE_PARTENAIRE_MAX).toBe(40);
        expect(nettoyerCodePartenaire('a'.repeat(100))).toHaveLength(40);
    });

    test('valeur absente ou non textuelle : chaîne vide', () => {
        expect(nettoyerCodePartenaire(null)).toBe('');
        expect(nettoyerCodePartenaire(undefined)).toBe('');
        expect(nettoyerCodePartenaire({ toString: () => 'X' })).toBe('');
        expect(nettoyerCodePartenaire(42)).toBe('');
    });
});

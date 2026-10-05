const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { PAGES_SECTEUR, PAGES_LEGALES, PAGES_PUBLIQUES } = require('../src/pagesPubliques');
const { securiteHeaders } = require('../src/csp');

// Les pages de secteur et les pages légales sont GÉNÉRÉES (outils/generer-pages-marketing.js) : ces tests empêchent
// qu'elles dérivent de la page d'accueil, qu'un lien casse ou qu'une page sorte de la liste des routes et de la CSP.
const WEB = path.join(__dirname, '..', '..', 'web');
const lire = (nom) => fs.readFileSync(path.join(WEB, nom), 'utf8');
const TOUTES = ['decouvrir', ...PAGES_PUBLIQUES];

describe('pages marketing générées', () => {
    test.each(PAGES_PUBLIQUES)('%s : un seul titre h1, un titre de page et une description propres, URL canonique', (nom) => {
        const html = lire(`${nom}.html`);
        expect(html.match(/<h1[ >]/g)).toHaveLength(1);
        expect(html).toMatch(/<title>[^<]{10,}<\/title>/);
        expect(html).toMatch(/<meta name="description" content="[^"]{60,}"/);
        expect(html).toContain(`<link rel="canonical" href="https://massla.sn/${nom}" />`);
        expect(html).toContain('<meta name="theme-color" content="#0F3D2E" />');
    });

    test('chaque page a un titre différent', () => {
        const titres = TOUTES.map((nom) => lire(`${nom}.html`).match(/<title>([^<]*)<\/title>/)[1]);
        expect(new Set(titres).size).toBe(titres.length);
    });

    test.each(PAGES_PUBLIQUES)('%s : les données structurées sont du JSON valide', (nom) => {
        const blocs = [...lire(`${nom}.html`).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
        expect(blocs.length).toBeGreaterThan(0);
        blocs.forEach((b) => expect(() => JSON.parse(b[1])).not.toThrow());
    });

    test.each(PAGES_SECTEUR)('%s : questions fréquentes balisées pour Google, formulaire de démo présent', (nom) => {
        const html = lire(`${nom}.html`);
        const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((b) => JSON.parse(b[1])).find((j) => j['@type'] === 'FAQPage');
        expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
        expect(html).toContain('id="modal-contact"');
        expect(html).toContain('/js/dist/marketing.min.js');
        // la page résume ses propres questions : même nombre de <details> que de questions balisées
        expect(html.match(/<details name="faq"/g)).toHaveLength(faq.mainEntity.length);
    });

    test.each(PAGES_LEGALES)('%s : aucun bouton de démo qui pointerait vers un formulaire absent', (nom) => {
        const html = lire(`${nom}.html`);
        expect(html).not.toContain('data-open-contact');
        expect(html).not.toContain('id="modal-contact"');
    });

    test('les mentions légales portent les identifiants de la société', () => {
        const html = lire('mentions.html');
        expect(html).toContain('FAYSSALAME');
        expect(html).toContain('012050225');
        expect(html).toContain('SN.DKR.2025.B.13520');
    });

    test('tous les liens internes pointent vers une page ou un fichier qui existe', () => {
        const manquants = [];
        for (const nom of TOUTES) {
            for (const [, href] of lire(`${nom}.html`).matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
                if (href.startsWith('//') || href.startsWith('/api/')) continue;
                const cible = href === '/' ? 'index.html' : PAGES_PUBLIQUES.includes(href.slice(1)) || href === '/decouvrir' ? `${href.slice(1)}.html` : href.slice(1);
                if (!fs.existsSync(path.join(WEB, cible))) manquants.push(`${nom}.html → ${href}`);
            }
        }
        expect(manquants).toEqual([]);
    });

    test("la page d'accueil renvoie vers chaque secteur et vers les pages légales", () => {
        const html = lire('decouvrir.html');
        PAGES_PUBLIQUES.forEach((nom) => expect(html).toContain(`href="/${nom}"`));
    });

    test('le plan du site liste toutes les pages publiques', () => {
        const plan = lire('sitemap.xml');
        TOUTES.forEach((nom) => expect(plan).toContain(`<loc>https://massla.sn/${nom}</loc>`));
        const robots = lire('robots.txt');
        expect(robots).toContain('Sitemap: https://massla.sn/sitemap.xml');
        expect(robots).toContain('Disallow: /api/');
    });
});

describe('pages marketing — sécurité (CSP)', () => {
    const app = express();
    app.use(securiteHeaders);
    app.get('*', (req, res) => res.send('ok'));
    const csp = async (chemin) => (await request(app).get(chemin)).headers['content-security-policy'];

    test.each([...PAGES_SECTEUR, 'confidentialite'].flatMap((n) => [`/${n}`, `/${n}.html`]))('%s porte le suivi d\'audience', async (chemin) => {
        expect(await csp(chemin)).toContain('https://www.googletagmanager.com');
    });

    test('les mentions légales restent sur la CSP stricte (aucun suivi tiers)', async () => {
        for (const chemin of ['/mentions', '/mentions.html']) {
            const politique = await csp(chemin);
            expect(politique).not.toContain('googletagmanager');
            expect(politique).not.toContain('facebook');
        }
    });
});

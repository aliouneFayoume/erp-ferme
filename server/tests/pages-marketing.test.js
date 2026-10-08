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

    // Jamais de faux témoignage : la section d'avis est alimentée UNIQUEMENT par GET /api/avis (avis réels approuvés
    // par la modération) et reste cachée, titre compris, tant qu'il n'y en a aucun.
    test.each(PAGES_SECTEUR)('%s : section d\'avis réels, cachée par défaut, sans témoignage écrit en dur', (nom) => {
        const html = lire(`${nom}.html`);
        expect(html).toMatch(/<section[^>]*id="avis"[^>]*data-avis-section hidden>/);
        expect(html).toContain('<div class="avis-grid" id="avis-grid" hidden></div>');
        expect(html).not.toContain('class="avis-card"');
        // pas de balisage Review/AggregateRating : Google interdit les avis auto-déclarés sur sa propre organisation
        expect(html).not.toMatch(/"@type":\s*"(Review|AggregateRating)"/);
    });

    // Seuls les relevés d'animaux (pesée, vaccination, traitement, observation) passent par la file hors ligne
    // (offline-queue.js) : nouvel animal, saillie, mise-bas et changement de statut demandent une connexion. La page
    // Élevage dit exactement cela, ni plus ni moins.
    test("la page Élevage décrit le hors-ligne tel qu'il est : relevés oui, nouvel animal / saillie / mise-bas non", () => {
        const vue = fs.readFileSync(path.join(WEB, 'js', 'views', 'elevage.js'), 'utf8');
        expect((vue.match(/OfflineQueue\.ajouter/g) || []).length).toBe(1); // une seule écriture est mise en file : le relevé
        expect(vue).toContain('/releves`'); // et c'est bien la route des relevés d'un animal
        const html = lire('elevage.html');
        expect(html).toContain('Peut-on saisir sans réseau dans les enclos');
        expect(html).toContain('pesées, vaccinations, traitements et observations');
        expect(html).toContain('demande en revanche une connexion');
    });

    // Hors ligne, seuls les relevés de production, les pesées et soins des animaux et la logistique passent par la file
    // d'attente ; commandes, paiements, stock et comptabilité demandent une connexion. La page d'accueil dit cela et ne
    // promet pas « toutes les données ». Le texte des données structurées (Google) doit rester identique à la page visible.
    test("la page d'accueil décrit le hors-ligne du terrain, sans promettre « toutes les données »", () => {
        const html = lire('decouvrir.html');
        expect(html).not.toMatch(/toutes les données|fonctionne hors ligne|fonctionnement hors ligne|Fonctionne sans internet/);
        expect(html).toContain("Le terrain n'attend pas le réseau");
        // la page d'accueil range ses données structurées dans un @graph (Organization, SoftwareApplication, FAQPage)
        const noeuds = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((b) => {
            const j = JSON.parse(b[1]);
            return j['@graph'] || [j];
        });
        const faq = noeuds.find((n) => n['@type'] === 'FAQPage');
        const reponse = faq.mainEntity.find((q) => q.name.includes('sans connexion internet')).acceptedAnswer.text;
        expect(reponse).toContain('demandent une connexion');
        expect(html).toContain(`<p>${reponse}</p>`);
    });

    // Aucune table ne relie un animal à une ligne de commande : la vente (module Commandes, produit « tête » rattaché à
    // une espèce) et le statut de la fiche sont deux gestes distincts. La page ne doit pas promettre un lien automatique.
    test('la page Élevage ne promet pas de vente ni d\'encaissement automatiques des animaux', () => {
        expect(lire('elevage.html')).not.toContain('Vendez vos animaux');
        expect(lire('elevage.html')).toContain('Ventes et sorties');
    });

    test('le script révèle la section entière quand un avis réel existe', () => {
        expect(lire('js/avis-decouvrir.js')).toMatch(/closest\('\[data-avis-section\]'\)/);
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
        // Les bundles /js/dist/*.min.js sont GÉNÉRÉS par web/build.js : le dossier est ignoré par git, donc absent
        // d'un checkout propre (CI). On vérifie qu'ils sont déclarés dans build.js et que leurs sources existent.
        const bundles = {};
        for (const [, bundle, liste] of lire('build.js').matchAll(/'([\w-]+\.min\.js)':\s*\[([^\]]*)\]/g)) {
            bundles[bundle] = [...liste.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        }
        const manquants = [];
        for (const nom of TOUTES) {
            for (const [, href] of lire(`${nom}.html`).matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
                if (href.startsWith('//') || href.startsWith('/api/')) continue;
                if (href.startsWith('/js/dist/')) {
                    const sources = bundles[href.slice('/js/dist/'.length)];
                    if (!sources || sources.length === 0 || sources.some((s) => !fs.existsSync(path.join(WEB, s)))) manquants.push(`${nom}.html → ${href}`);
                    continue;
                }
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

    test('le fichier de validation Google Search Console est présent (le supprimer fait perdre le statut de propriétaire)', () => {
        expect(lire('google0aab26dec2f307df.html')).toBe('google-site-verification: google0aab26dec2f307df.html');
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

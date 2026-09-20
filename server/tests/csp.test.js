const express = require('express');
const request = require('supertest');
const { securiteHeaders, PAGES_MARKETING } = require('../src/csp');

// Le suivi marketing (Google Analytics 4, Meta Pixel) ne doit ouvrir la CSP QUE sur les pages
// publiques qui le portent : l'application de gestion et le portail client restent stricts.
function appDeTest() {
    const app = express();
    app.use(securiteHeaders);
    app.get('*', (req, res) => res.send('ok'));
    return app;
}

const csp = async (chemin) => (await request(appDeTest()).get(chemin)).headers['content-security-policy'];

describe('CSP — suivi marketing limité aux pages publiques', () => {
    test.each([...PAGES_MARKETING])('%s autorise Google Tag Manager et le pixel Meta', async (chemin) => {
        const politique = await csp(chemin);
        expect(politique).toContain('https://www.googletagmanager.com');
        expect(politique).toContain('https://connect.facebook.net');
        expect(politique).toContain('https://www.google-analytics.com');
        expect(politique).toContain('https://www.facebook.com');
    });

    test.each(['/', '/index.html', '/portail.html', '/api/health', '/api/clients'])('%s reste sur la CSP stricte', async (chemin) => {
        const politique = await csp(chemin);
        expect(politique).not.toContain('googletagmanager');
        expect(politique).not.toContain('facebook');
        expect(politique).not.toContain('google-analytics');
    });

    test('les scripts de la page publique restent limités : pas de unsafe-inline ni de wildcard de script', async () => {
        const politique = await csp('/decouvrir');
        const scriptSrc = politique.split(';').find((d) => d.trim().startsWith('script-src ')).trim();
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect(scriptSrc).not.toContain('*');
    });

    test("les autres protections d'helmet restent actives sur les pages publiques", async () => {
        const res = await request(appDeTest()).get('/decouvrir');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    });
});

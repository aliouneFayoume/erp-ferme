const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Jamais de vrai appel réseau vers PayDunya / Resend en test.
jest.mock('../src/paydunya');
jest.mock('../src/paymentConfig');
jest.mock('../src/whatsapp');
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn().mockResolvedValue({}),
}));
const { creerFacture, confirmerFacture } = require('../src/paydunya');
const { getPaydunyaConfig } = require('../src/paymentConfig');
const { envoyerEmailRappelSaas } = require('../src/email');
const { creerJeton } = require('../src/paiementsSaas');

const CREDENTIALS_MASSLA = { mode: 'live', masterKey: 'mk', privateKey: 'pk', publicKey: 'pubk', token: 'tk' };
const IL_Y_A = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

// Massla (organisation émettrice, qui encaisse) facture une ferme cliente : le superviseur de Massla obtient un
// lien STABLE, la ferme l'ouvre (un checkout PayDunya tout frais est créé et la ferme y est redirigée), paie, puis
// l'IPN marque la facture payée.
describe('paiements SaaS — se faire payer via PayDunya', () => {
    let pool;
    let app;
    let tenantMassla;
    let tenantFerme;
    let tokenSuperviseur;
    let tokenAdminFerme;
    let compteurToken = 0;

    async function creerFactureSaas({ montant = 35000, statut = 'A_PAYER', type = 'ABONNEMENT', periode = '2026-10' } = {}) {
        const res = await pool.query(
            `INSERT INTO factures_saas (tenant_id, type, periode, montant, statut, date_echeance) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE) RETURNING id`,
            [tenantFerme, type, periode, montant, statut]
        );
        return res.rows[0].id;
    }

    /** Le superviseur demande le lien à envoyer à la ferme. */
    const demanderLien = (factureId, token = tokenSuperviseur) =>
        request(app).post(`/api/plateforme/factures-saas/${factureId}/lien-paiement`).set('Authorization', `Bearer ${token}`);

    /** La ferme ouvre le lien reçu (sans connexion). */
    const ouvrirLien = (factureId) => request(app).get(`/api/payer/${creerJeton(factureId)}`);

    const ipn = (token) => request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

    const facture = async (id) => (await pool.query(`SELECT * FROM factures_saas WHERE id = $1`, [id])).rows[0];
    const paiements = async (factureId) => (await pool.query(`SELECT * FROM paiements_saas WHERE facture_saas_id = $1 ORDER BY id`, [factureId])).rows;

    /** PayDunya confirme un paiement terminé, avec le montant et la référence attendus par défaut. */
    const confirmeCompleted = (paiementRow, surcharges = {}) =>
        confirmerFacture.mockResolvedValueOnce({
            status: 'completed',
            montant: paiementRow.montant,
            referenceInterne: paiementRow.reference_interne,
            providerReference: 'MAXIT-123',
            ...surcharges,
        });

    beforeEach(async () => {
        jest.clearAllMocks();
        compteurToken = 0;
        creerFacture.mockImplementation(async () => {
            compteurToken += 1;
            return { token: `tok-${compteurToken}`, url: `https://paydunya.test/checkout/tok-${compteurToken}` };
        });
        confirmerFacture.mockReset();
        getPaydunyaConfig.mockResolvedValue(CREDENTIALS_MASSLA);

        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantMassla = await creerOrganisation(pool, 'Ferme Massla');
        tenantFerme = await creerOrganisation(pool, 'Ganaar Boumak');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantMassla, estSuperviseurPlateforme: true });
        tokenAdminFerme = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantFerme, estSuperviseurPlateforme: false });
        app = buildApp(pool, ['plateforme', 'finance', 'payer']);
    });

    afterEach(async () => {
        await pool.end();
    });

    describe('le superviseur obtient un lien stable', () => {
        test('renvoie l’adresse Massla /api/payer/<jeton> (jamais l’adresse PayDunya) sans créer de checkout', async () => {
            const factureId = await creerFactureSaas();

            const res = await demanderLien(factureId);

            expect(res.status).toBe(200);
            expect(res.body.url).toMatch(new RegExp(`/api/payer/${factureId}\\.[A-Za-z0-9_-]{43}$`));
            expect(res.body.url).not.toContain('paydunya');
            expect(res.body.mode).toBe('live');
            expect(getPaydunyaConfig).toHaveBeenCalledWith(expect.anything(), tenantMassla); // vérifie la config de Massla, jamais celle de la ferme
            expect(creerFacture).not.toHaveBeenCalled(); // le checkout n'est créé qu'à l'ouverture du lien
            expect(await paiements(factureId)).toHaveLength(0);
        });

        test('le même lien est renvoyé à chaque demande (il est stable)', async () => {
            const factureId = await creerFactureSaas();

            const premier = await demanderLien(factureId);
            const second = await demanderLien(factureId);

            // supertest ouvre un port différent à chaque requête : on compare le chemin, pas l'hôte.
            expect(new URL(second.body.url).pathname).toBe(new URL(premier.body.url).pathname);
        });

        test.each(['PAYEE', 'ANNULEE'])('refuse une facture %s', async (statut) => {
            const factureId = await creerFactureSaas({ statut });
            expect((await demanderLien(factureId)).status).toBe(400);
        });

        test('accepte une facture EN_RETARD', async () => {
            const factureId = await creerFactureSaas({ statut: 'EN_RETARD' });
            expect((await demanderLien(factureId)).status).toBe(200);
        });

        test('400 explicite si Massla n’a pas configuré PayDunya (le superviseur le voit tout de suite)', async () => {
            getPaydunyaConfig.mockResolvedValue(null);
            const factureId = await creerFactureSaas();

            const res = await demanderLien(factureId);

            expect(res.status).toBe(400);
            expect(res.body.erreur).toMatch(/PayDunya/);
        });

        test('404 pour une facture inconnue', async () => {
            expect((await demanderLien(99999)).status).toBe(404);
        });

        test('réservé au superviseur plateforme (une ferme ne génère jamais de lien)', async () => {
            const factureId = await creerFactureSaas();
            expect((await demanderLien(factureId, tokenAdminFerme)).status).toBe(403);
        });
    });

    describe('la ferme ouvre le lien', () => {
        test('crée un checkout PayDunya avec les clés de Massla, l’enregistre et redirige vers PayDunya', async () => {
            const factureId = await creerFactureSaas({ montant: 35000 });

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('https://paydunya.test/checkout/tok-1');
            expect(res.headers['cache-control']).toContain('no-store');
            expect(creerFacture).toHaveBeenCalledWith(
                expect.objectContaining({
                    montant: 35000,
                    storeName: 'Massla',
                    credentials: CREDENTIALS_MASSLA,
                    retourChemin: '/paiement-abonnement-succes.html',
                    annulationChemin: '/paiement-abonnement-annule.html',
                })
            );
            expect(creerFacture.mock.calls[0][0].description).toContain('Ganaar Boumak');
            const lignes = await paiements(factureId);
            expect(lignes).toHaveLength(1);
            expect(lignes[0]).toMatchObject({ token: 'tok-1', statut: 'EN_ATTENTE', tenant_id: tenantFerme, emetteur_tenant_id: tenantMassla });
            expect(Number(lignes[0].montant)).toBe(35000);
            expect(lignes[0].reference_interne).toBe(creerFacture.mock.calls[0][0].referenceInterne);
        });

        test('une seconde ouverture dans les 10 minutes reprend le même checkout', async () => {
            const factureId = await creerFactureSaas();

            await ouvrirLien(factureId);
            const second = await ouvrirLien(factureId);

            expect(second.headers.location).toBe('https://paydunya.test/checkout/tok-1');
            expect(creerFacture).toHaveBeenCalledTimes(1);
            expect(await paiements(factureId)).toHaveLength(1);
        });

        test('au-delà de 10 minutes, un checkout tout frais est créé (l’ancien expire ~30 min après sa création) et l’ancien reste enregistré', async () => {
            const factureId = await creerFactureSaas();
            await ouvrirLien(factureId);
            await pool.query(`UPDATE paiements_saas SET cree_le = $1`, [IL_Y_A(25)]);

            const second = await ouvrirLien(factureId);

            expect(second.status).toBe(302);
            expect(second.headers.location).toBe('https://paydunya.test/checkout/tok-2');
            expect((await paiements(factureId)).map((p) => p.token)).toEqual(['tok-1', 'tok-2']);
        });

        test('le lien fonctionne encore le lendemain : il ne dépend pas de la durée de vie du checkout', async () => {
            const factureId = await creerFactureSaas();
            await ouvrirLien(factureId);
            await pool.query(`UPDATE paiements_saas SET cree_le = $1`, [IL_Y_A(24 * 60)]);

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('https://paydunya.test/checkout/tok-2');
        });

        test('jeton falsifié : 404, PayDunya n’est jamais appelé', async () => {
            const factureId = await creerFactureSaas();
            const jeton = creerJeton(factureId);
            const falsifie = `${factureId}.${jeton.split('.')[1].slice(0, -1)}${jeton.endsWith('A') ? 'B' : 'A'}`;

            const res = await request(app).get(`/api/payer/${falsifie}`);

            expect(res.status).toBe(404);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('jeton d’une autre facture (identifiant modifié, signature conservée) : 404', async () => {
            const factureA = await creerFactureSaas();
            const factureB = await creerFactureSaas({ montant: 99999 });
            const signatureDeA = creerJeton(factureA).split('.')[1];

            const res = await request(app).get(`/api/payer/${factureB}.${signatureDeA}`);

            expect(res.status).toBe(404);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('jeton absurde : 404', async () => {
            expect((await request(app).get('/api/payer/n-importe-quoi')).status).toBe(404);
        });

        test('facture déjà payée : message clair, aucun nouveau paiement', async () => {
            const factureId = await creerFactureSaas({ statut: 'PAYEE' });

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(200);
            expect(res.text).toMatch(/déjà réglée/);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('facture annulée : message clair, aucun paiement', async () => {
            const factureId = await creerFactureSaas({ statut: 'ANNULEE' });

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(410);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('PayDunya non configuré : page d’indisponibilité (503), pas d’erreur brute', async () => {
            getPaydunyaConfig.mockResolvedValue(null);
            const factureId = await creerFactureSaas();

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(503);
            expect(res.text).toMatch(/indisponible/i);
        });

        test('PayDunya injoignable : page « réessayez » (502) et aucune ligne enregistrée', async () => {
            creerFacture.mockRejectedValueOnce(new Error('timeout'));
            const factureId = await creerFactureSaas();

            const res = await ouvrirLien(factureId);

            expect(res.status).toBe(502);
            expect(await paiements(factureId)).toHaveLength(0);
        });
    });

    describe('confirmation par l’IPN PayDunya', () => {
        async function factureAvecCheckout(options) {
            const factureId = await creerFactureSaas(options);
            await ouvrirLien(factureId);
            return { factureId, paiement: (await paiements(factureId))[0] };
        }

        test('paiement confirmé : la facture passe PAYEE (méthode PAYDUNYA) et la tentative VALIDE', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmeCompleted(paiement);

            const res = await ipn(paiement.token);

            expect(res.status).toBe(200);
            expect(confirmerFacture).toHaveBeenCalledWith(paiement.token, CREDENTIALS_MASSLA); // vérifié avec les clés de Massla
            const f = await facture(factureId);
            expect(f.statut).toBe('PAYEE');
            expect(f.methode_paiement).toBe('PAYDUNYA');
            expect(f.date_paiement).not.toBeNull();
            expect((await paiements(factureId))[0].statut).toBe('VALIDE');
        });

        test('une facture EN_RETARD payée par lien passe aussi PAYEE', async () => {
            const { factureId, paiement } = await factureAvecCheckout({ statut: 'EN_RETARD' });
            confirmeCompleted(paiement);

            await ipn(paiement.token);

            expect((await facture(factureId)).statut).toBe('PAYEE');
        });

        test('après paiement, rouvrir le lien affiche « déjà réglée » et ne crée rien', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmeCompleted(paiement);
            await ipn(paiement.token);
            creerFacture.mockClear();

            const res = await ouvrirLien(factureId);

            expect(res.text).toMatch(/déjà réglée/);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('paiement encore en attente ou annulé : aucune écriture', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmerFacture.mockResolvedValueOnce({ status: 'pending' });

            const res = await ipn(paiement.token);

            expect(res.status).toBe(200);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('EN_ATTENTE');
        });

        test('montant confirmé différent du montant demandé : tentative ECHOUE, facture intacte', async () => {
            const { factureId, paiement } = await factureAvecCheckout({ montant: 35000 });
            confirmeCompleted(paiement, { montant: 100 });

            const res = await ipn(paiement.token);

            expect(res.status).toBe(200);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('ECHOUE');
            const audit = await pool.query(`SELECT * FROM audit_logs WHERE table_name = 'paiements_saas' AND action = 'ANOMALIE_IPN'`);
            expect(audit.rows).toHaveLength(1);
        });

        test('référence interne différente : tentative ECHOUE, facture intacte', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmeCompleted(paiement, { referenceInterne: 'saas-autre-facture' });

            await ipn(paiement.token);

            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('ECHOUE');
        });

        test('IPN dupliquée (retry PayDunya) : rien n’est validé deux fois', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmeCompleted(paiement);
            await ipn(paiement.token);
            const datePremierPaiement = (await facture(factureId)).date_paiement;
            confirmeCompleted(paiement);

            const second = await ipn(paiement.token);

            expect(second.status).toBe(200);
            expect(second.body.message).toMatch(/idempotence/i);
            expect((await facture(factureId)).date_paiement).toEqual(datePremierPaiement);
        });

        test('deux checkouts pour la même facture : l’ancien reste payable, le second paiement est un DOUBLON non crédité', async () => {
            const factureId = await creerFactureSaas();
            await ouvrirLien(factureId);
            await pool.query(`UPDATE paiements_saas SET cree_le = $1`, [IL_Y_A(25)]);
            await ouvrirLien(factureId);
            const [ancien, recent] = await paiements(factureId);

            confirmeCompleted(ancien);
            await ipn(ancien.token); // la ferme paie avec l'ancien checkout : la facture est bien réglée
            expect((await facture(factureId)).statut).toBe('PAYEE');

            confirmeCompleted(recent);
            const res = await ipn(recent.token); // puis avec le nouveau : argent reçu mais facture déjà payée
            expect(res.status).toBe(200);
            expect((await paiements(factureId)).map((p) => p.statut)).toEqual(['VALIDE', 'DOUBLON']);
            expect((await facture(factureId)).statut).toBe('PAYEE');
        });

        test('facture annulée entre-temps : paiement marqué DOUBLON, facture toujours ANNULEE', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            await pool.query(`UPDATE factures_saas SET statut = 'ANNULEE' WHERE id = $1`, [factureId]);
            confirmeCompleted(paiement);

            await ipn(paiement.token);

            expect((await facture(factureId)).statut).toBe('ANNULEE');
            expect((await paiements(factureId))[0].statut).toBe('DOUBLON');
        });

        test('token inconnu partout : 200 « idempotence », sans appeler PayDunya', async () => {
            const res = await ipn('token-que-personne-ne-connait');

            expect(res.status).toBe(200);
            expect(confirmerFacture).not.toHaveBeenCalled();
        });

        test('PayDunya injoignable pendant la vérification : 502, rien n’est crédité (PayDunya retentera)', async () => {
            const { factureId, paiement } = await factureAvecCheckout();
            confirmerFacture.mockRejectedValueOnce(new Error('réseau'));

            const res = await ipn(paiement.token);

            expect(res.status).toBe(502);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
        });
    });

    describe('rappel par email', () => {
        test('le rappel email contient le lien STABLE quand PayDunya est configuré', async () => {
            const factureId = await creerFactureSaas();

            const res = await request(app)
                .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
                .set('Authorization', `Bearer ${tokenSuperviseur}`);

            expect(res.status).toBe(200);
            expect(envoyerEmailRappelSaas.mock.calls[0][1].lienPaiement).toMatch(new RegExp(`/api/payer/${factureId}\\.`));
        });

        test('le rappel part quand même, sans lien, si PayDunya n’est pas configuré', async () => {
            getPaydunyaConfig.mockResolvedValue(null);
            const factureId = await creerFactureSaas();

            const res = await request(app)
                .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
                .set('Authorization', `Bearer ${tokenSuperviseur}`);

            expect(res.status).toBe(200);
            expect(envoyerEmailRappelSaas.mock.calls[0][1].lienPaiement).toBeNull();
        });
    });
});

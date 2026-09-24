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

const CREDENTIALS_MASSLA = { mode: 'live', masterKey: 'mk', privateKey: 'pk', publicKey: 'pubk', token: 'tk' };

// Massla (organisation émettrice, qui encaisse) facture une ferme cliente : le lien est généré par le
// superviseur de Massla, la ferme paie, l'IPN marque la facture payée.
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

    const genererLien = (factureId, token = tokenSuperviseur) =>
        request(app).post(`/api/plateforme/factures-saas/${factureId}/lien-paiement`).set('Authorization', `Bearer ${token}`);

    const ipn = (token) => request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

    const facture = async (id) => (await pool.query(`SELECT * FROM factures_saas WHERE id = $1`, [id])).rows[0];
    const paiements = async (factureId) => (await pool.query(`SELECT * FROM paiements_saas WHERE facture_saas_id = $1 ORDER BY id`, [factureId])).rows;

    /** PayDunya confirme un paiement terminé, avec le montant et la référence attendus par défaut. */
    const confirmeCompleted = (paiementRow, surcharges = {}) =>
        confirmerFacture.mockResolvedValueOnce({
            status: 'completed',
            montant: paiementRow.montant,
            referenceInterne: paiementRow.reference_interne,
            providerReference: 'WAVE-123',
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
        app = buildApp(pool, ['plateforme', 'finance']);
    });

    afterEach(async () => {
        await pool.end();
    });

    describe('génération du lien de paiement', () => {
        test('crée un checkout PayDunya avec les clés de Massla et enregistre la tentative', async () => {
            const factureId = await creerFactureSaas({ montant: 35000 });

            const res = await genererLien(factureId);

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ url: 'https://paydunya.test/checkout/tok-1', token: 'tok-1', reutilise: false, mode: 'live' });
            expect(getPaydunyaConfig).toHaveBeenCalledWith(expect.anything(), tenantMassla); // l'argent va chez Massla, jamais chez la ferme
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

        test('renvoie le même lien tant qu’il a moins de 24 h (un seul checkout créé)', async () => {
            const factureId = await creerFactureSaas();

            await genererLien(factureId);
            const second = await genererLien(factureId);

            expect(second.status).toBe(200);
            expect(second.body).toMatchObject({ token: 'tok-1', reutilise: true });
            expect(creerFacture).toHaveBeenCalledTimes(1);
            expect(await paiements(factureId)).toHaveLength(1);
        });

        test('crée un nouveau lien au-delà de 24 h, l’ancien reste enregistré', async () => {
            const factureId = await creerFactureSaas();
            await genererLien(factureId);
            await pool.query(`UPDATE paiements_saas SET cree_le = $1`, [new Date(Date.now() - 2 * 24 * 3600 * 1000)]);

            const second = await genererLien(factureId);

            expect(second.status).toBe(201);
            expect(second.body.token).toBe('tok-2');
            expect((await paiements(factureId)).map((p) => p.token)).toEqual(['tok-1', 'tok-2']);
        });

        test.each(['PAYEE', 'ANNULEE'])('refuse une facture %s', async (statut) => {
            const factureId = await creerFactureSaas({ statut });

            const res = await genererLien(factureId);

            expect(res.status).toBe(400);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('accepte une facture EN_RETARD', async () => {
            const factureId = await creerFactureSaas({ statut: 'EN_RETARD' });
            expect((await genererLien(factureId)).status).toBe(201);
        });

        test('400 explicite si Massla n’a pas configuré PayDunya', async () => {
            getPaydunyaConfig.mockResolvedValue(null);
            const factureId = await creerFactureSaas();

            const res = await genererLien(factureId);

            expect(res.status).toBe(400);
            expect(res.body.erreur).toMatch(/PayDunya/);
            expect(creerFacture).not.toHaveBeenCalled();
        });

        test('502 et aucune ligne enregistrée si PayDunya est injoignable', async () => {
            creerFacture.mockRejectedValueOnce(new Error('timeout'));
            const factureId = await creerFactureSaas();

            const res = await genererLien(factureId);

            expect(res.status).toBe(502);
            expect(await paiements(factureId)).toHaveLength(0);
        });

        test('404 pour une facture inconnue', async () => {
            expect((await genererLien(99999)).status).toBe(404);
        });

        test('réservé au superviseur plateforme (une ferme ne génère jamais de lien)', async () => {
            const factureId = await creerFactureSaas();

            const res = await genererLien(factureId, tokenAdminFerme);

            expect(res.status).toBe(403);
            expect(creerFacture).not.toHaveBeenCalled();
        });
    });

    describe('confirmation par l’IPN PayDunya', () => {
        async function factureAvecLien(options) {
            const factureId = await creerFactureSaas(options);
            await genererLien(factureId);
            return { factureId, paiement: (await paiements(factureId))[0] };
        }

        test('paiement confirmé : la facture passe PAYEE (méthode PAYDUNYA) et la tentative VALIDE', async () => {
            const { factureId, paiement } = await factureAvecLien();
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
            const { factureId, paiement } = await factureAvecLien({ statut: 'EN_RETARD' });
            confirmeCompleted(paiement);

            await ipn(paiement.token);

            expect((await facture(factureId)).statut).toBe('PAYEE');
        });

        test('paiement encore en attente ou annulé : aucune écriture', async () => {
            const { factureId, paiement } = await factureAvecLien();
            confirmerFacture.mockResolvedValueOnce({ status: 'pending' });

            const res = await ipn(paiement.token);

            expect(res.status).toBe(200);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('EN_ATTENTE');
        });

        test('montant confirmé différent du montant demandé : tentative ECHOUE, facture intacte', async () => {
            const { factureId, paiement } = await factureAvecLien({ montant: 35000 });
            confirmeCompleted(paiement, { montant: 100 });

            const res = await ipn(paiement.token);

            expect(res.status).toBe(200);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('ECHOUE');
            const audit = await pool.query(`SELECT * FROM audit_logs WHERE table_name = 'paiements_saas' AND action = 'ANOMALIE_IPN'`);
            expect(audit.rows).toHaveLength(1);
        });

        test('référence interne différente : tentative ECHOUE, facture intacte', async () => {
            const { factureId, paiement } = await factureAvecLien();
            confirmeCompleted(paiement, { referenceInterne: 'saas-autre-facture' });

            await ipn(paiement.token);

            expect((await facture(factureId)).statut).toBe('A_PAYER');
            expect((await paiements(factureId))[0].statut).toBe('ECHOUE');
        });

        test('IPN dupliquée (retry PayDunya) : rien n’est validé deux fois', async () => {
            const { factureId, paiement } = await factureAvecLien();
            confirmeCompleted(paiement);
            await ipn(paiement.token);
            const datePremierPaiement = (await facture(factureId)).date_paiement;
            confirmeCompleted(paiement);

            const second = await ipn(paiement.token);

            expect(second.status).toBe(200);
            expect(second.body.message).toMatch(/idempotence/i);
            expect((await facture(factureId)).date_paiement).toEqual(datePremierPaiement);
        });

        test('deux liens pour la même facture : l’ancien reste valable, le second paiement est un DOUBLON non crédité', async () => {
            const factureId = await creerFactureSaas();
            await genererLien(factureId);
            await pool.query(`UPDATE paiements_saas SET cree_le = $1`, [new Date(Date.now() - 2 * 24 * 3600 * 1000)]);
            await genererLien(factureId);
            const [ancien, recent] = await paiements(factureId);

            confirmeCompleted(ancien);
            await ipn(ancien.token); // la ferme paie avec l'ancien lien : la facture est bien réglée
            expect((await facture(factureId)).statut).toBe('PAYEE');

            confirmeCompleted(recent);
            const res = await ipn(recent.token); // puis avec le nouveau : argent reçu mais déjà payée
            expect(res.status).toBe(200);
            expect((await paiements(factureId)).map((p) => p.statut)).toEqual(['VALIDE', 'DOUBLON']);
            expect((await facture(factureId)).statut).toBe('PAYEE');
        });

        test('facture annulée entre-temps : paiement marqué DOUBLON, facture toujours ANNULEE', async () => {
            const { factureId, paiement } = await factureAvecLien();
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
            const { factureId, paiement } = await factureAvecLien();
            confirmerFacture.mockRejectedValueOnce(new Error('réseau'));

            const res = await ipn(paiement.token);

            expect(res.status).toBe(502);
            expect((await facture(factureId)).statut).toBe('A_PAYER');
        });
    });

    describe('rappel par email', () => {
        test('le rappel email contient le lien de paiement quand PayDunya est configuré', async () => {
            const factureId = await creerFactureSaas();

            const res = await request(app)
                .post(`/api/plateforme/factures-saas/${factureId}/rappel-email`)
                .set('Authorization', `Bearer ${tokenSuperviseur}`);

            expect(res.status).toBe(200);
            expect(envoyerEmailRappelSaas.mock.calls[0][1].lienPaiement).toBe('https://paydunya.test/checkout/tok-1');
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

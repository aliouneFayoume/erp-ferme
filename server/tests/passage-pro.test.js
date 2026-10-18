const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Jamais de vrai appel réseau vers PayDunya / Resend / Meta en test.
jest.mock('../src/paydunya');
jest.mock('../src/paymentConfig');
jest.mock('../src/whatsapp');
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn().mockResolvedValue({}),
}));
// Re-requis après jest.resetModules() à chaque test (limiteur de débit de la route instancié au chargement du module, voir contact.test.js).
let creerFacture;
let confirmerFacture;
let getPaydunyaConfig;

const CREDENTIALS_MASSLA = { mode: 'live', masterKey: 'mk', privateKey: 'pk', publicKey: 'pubk', token: 'tk' };
const JOUR_MS = 24 * 3600 * 1000;

describe('passage en Pro depuis l’application — paiement en ligne et demande de rappel', () => {
    let pool;
    let app;
    let tenantMassla;
    let tenantFerme;
    let tokenAdmin;
    let compteur = 0;
    const ancienEnv = { ...process.env };

    async function definirOffre(tenant, plan, { finEssaiJours = 10, montant = 0 } = {}) {
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, plan, essai_debut_le, essai_fin_le)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenant, [], montant, plan, new Date(), new Date(Date.now() + finEssaiJours * JOUR_MS)]
        );
    }
    const post = (url, corps = {}, t = tokenAdmin) => request(app).post(url).set('Authorization', `Bearer ${t}`).send(corps);
    const abonnement = async (tenant = tenantFerme) => (await pool.query(`SELECT * FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];
    const factures = async () => (await pool.query(`SELECT * FROM factures_saas WHERE tenant_id = $1 ORDER BY id`, [tenantFerme])).rows;
    const ipn = (token) => request(app).post('/api/finance/paiements/ipn').send({ data: { token } });

    /** La ferme ouvre le lien stable reçu : un checkout PayDunya est créé, on renvoie la ligne paiements_saas. */
    async function ouvrirLienEtPayer(url) {
        const chemin = new URL(url).pathname;
        const ouverture = await request(app).get(chemin);
        expect(ouverture.status).toBe(302);
        const ligne = (await pool.query(`SELECT * FROM paiements_saas ORDER BY id DESC LIMIT 1`)).rows[0];
        confirmerFacture.mockResolvedValueOnce({ status: 'completed', montant: ligne.montant, referenceInterne: ligne.reference_interne, providerReference: 'WAVE-1' });
        return ligne;
    }

    beforeEach(async () => {
        jest.resetModules();
        ({ creerFacture, confirmerFacture } = require('../src/paydunya'));
        ({ getPaydunyaConfig } = require('../src/paymentConfig'));
        compteur = 0;
        creerFacture.mockImplementation(async () => {
            compteur += 1;
            return { token: `tok-${compteur}`, url: `https://paydunya.test/checkout/tok-${compteur}` };
        });
        confirmerFacture.mockReset();
        getPaydunyaConfig.mockResolvedValue(CREDENTIALS_MASSLA);
        process.env.PASSAGE_PRO_EN_LIGNE_ACTIF = 'true';

        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantMassla = await creerOrganisation(pool, 'Ferme Massla');
        tenantFerme = await creerOrganisation(pool, 'Ganaar Boumak');
        await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantMassla, estSuperviseurPlateforme: true });
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', nom_complet: 'Awa Ndiaye', tenant_id: tenantFerme });
        await definirOffre(tenantFerme, 'ESSAI');
        app = buildApp(pool, ['abonnement', 'auth', 'finance', 'payer']);
    });
    afterEach(async () => {
        process.env = { ...ancienEnv };
        await pool.end();
    });

    describe('paiement en ligne', () => {
        test('fermé par défaut : 503 explicite, aucune facture créée', async () => {
            delete process.env.PASSAGE_PRO_EN_LIGNE_ACTIF;
            const res = await post('/api/abonnement/passer-pro');
            expect(res.status).toBe(503);
            expect(res.body.code).toBe('PASSAGE_PRO_INDISPONIBLE');
            expect(await factures()).toHaveLength(0);
        });

        test('crée la facture du premier mois Pro (10 000) et renvoie le lien stable de Massla, sans rien activer', async () => {
            const res = await post('/api/abonnement/passer-pro');
            expect(res.status).toBe(200);
            expect(res.body.montant).toBe(10000);
            expect(res.body.url).toMatch(/\/api\/payer\/\d+\.[A-Za-z0-9_-]{43}$/);
            expect(res.body.url).not.toContain('paydunya');

            const [f] = await factures();
            expect(f).toMatchObject({ type: 'ABONNEMENT', montant: 10000, statut: 'A_PAYER', notes: 'PASSAGE_PRO' });
            // un clic ne vaut pas paiement : l'offre est inchangée
            expect((await abonnement()).plan).toBe('ESSAI');
        });

        test('PRO_PRIX_MENSUEL règle le prix', async () => {
            process.env.PRO_PRIX_MENSUEL = '12000';
            const res = await post('/api/abonnement/passer-pro');
            expect(res.body.montant).toBe(12000);
            expect((await factures())[0].montant).toBe(12000);
        });

        test('plusieurs clics ne créent qu’une seule facture à payer', async () => {
            await post('/api/abonnement/passer-pro');
            const second = await post('/api/abonnement/passer-pro');
            expect(second.status).toBe(200);
            expect(await factures()).toHaveLength(1);
        });

        test('le paiement confirmé par PayDunya active le Pro (plan, prix mensuel, conversion mesurée) et trace l’opération', async () => {
            const { body } = await post('/api/abonnement/passer-pro');
            const ligne = await ouvrirLienEtPayer(body.url);

            const res = await ipn(ligne.token);
            expect(res.status).toBe(200);

            expect((await factures())[0].statut).toBe('PAYEE');
            const ab = await abonnement();
            expect(ab.plan).toBe('PRO');
            expect(Number(ab.montant_mensuel)).toBe(10000);
            expect(ab.converti_pro_le).not.toBeNull();
            expect(ab.actif).toBe(true);
            const audit = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE table_name = 'organisation_abonnement_saas' AND details::text LIKE '%paiement_en_ligne%'`);
            expect(audit.rows[0].n).toBe(1);

            // /me annonce désormais le Pro : plus de bandeau d'essai
            const me = (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)).body.utilisateur;
            expect(me.offre.plan).toBe('PRO');
        });

        test('une IPN dupliquée ne réactive rien et ne double rien', async () => {
            const { body } = await post('/api/abonnement/passer-pro');
            const ligne = await ouvrirLienEtPayer(body.url);
            confirmerFacture.mockResolvedValue({ status: 'completed', montant: ligne.montant, referenceInterne: ligne.reference_interne, providerReference: 'WAVE-1' });
            await ipn(ligne.token);
            const second = await ipn(ligne.token);
            expect(second.status).toBe(200);
            expect((await abonnement()).plan).toBe('PRO');
            expect(await factures()).toHaveLength(1);
        });

        test('un paiement incohérent (montant différent) n’active RIEN', async () => {
            const { body } = await post('/api/abonnement/passer-pro');
            await request(app).get(new URL(body.url).pathname);
            const ligne = (await pool.query(`SELECT * FROM paiements_saas ORDER BY id DESC LIMIT 1`)).rows[0];
            confirmerFacture.mockResolvedValueOnce({ status: 'completed', montant: 1, referenceInterne: ligne.reference_interne, providerReference: 'X' });
            await ipn(ligne.token);
            expect((await abonnement()).plan).toBe('ESSAI');
            expect((await factures())[0].statut).toBe('A_PAYER');
        });

        test('PayDunya « en attente » (non terminé) : rien n’est activé', async () => {
            const { body } = await post('/api/abonnement/passer-pro');
            await request(app).get(new URL(body.url).pathname);
            const ligne = (await pool.query(`SELECT * FROM paiements_saas ORDER BY id DESC LIMIT 1`)).rows[0];
            confirmerFacture.mockResolvedValueOnce({ status: 'pending' });
            await ipn(ligne.token);
            expect((await abonnement()).plan).toBe('ESSAI');
        });

        test('une facture mensuelle ordinaire payée n’active jamais le Pro (seule la facture « passage en Pro » le fait)', async () => {
            const id = (await pool.query(
                `INSERT INTO factures_saas (tenant_id, type, periode, montant, date_echeance) VALUES ($1, 'ABONNEMENT', '2026-10', 10000, CURRENT_DATE) RETURNING id`,
                [tenantFerme]
            )).rows[0].id;
            const { creerJeton } = require('../src/paiementsSaas');
            await request(app).get(`/api/payer/${creerJeton(id)}`);
            const ligne = (await pool.query(`SELECT * FROM paiements_saas ORDER BY id DESC LIMIT 1`)).rows[0];
            confirmerFacture.mockResolvedValueOnce({ status: 'completed', montant: ligne.montant, referenceInterne: ligne.reference_interne, providerReference: 'X' });
            await ipn(ligne.token);
            expect((await factures())[0].statut).toBe('PAYEE');
            expect((await abonnement()).plan).toBe('ESSAI');
        });

        test('une ferme dont l’essai est terminé (consultation seule) peut quand même payer', async () => {
            await pool.query(`UPDATE organisation_abonnement_saas SET essai_fin_le = $1 WHERE tenant_id = $2`, [new Date(Date.now() - 2 * JOUR_MS), tenantFerme]);
            const res = await post('/api/abonnement/passer-pro');
            expect(res.status).toBe(200);
        });

        test('refuse une ferme déjà Pro, une ferme sur mesure, un non-admin et un appel sans session', async () => {
            await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'PRO' WHERE tenant_id = $1`, [tenantFerme]);
            expect((await post('/api/abonnement/passer-pro')).status).toBe(409);

            await pool.query(`UPDATE organisation_abonnement_saas SET plan = NULL WHERE tenant_id = $1`, [tenantFerme]);
            expect((await post('/api/abonnement/passer-pro')).status).toBe(409);

            await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'ESSAI' WHERE tenant_id = $1`, [tenantFerme]);
            const comptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantFerme });
            expect((await post('/api/abonnement/passer-pro', {}, comptable)).status).toBe(403);
            expect((await request(app).post('/api/abonnement/passer-pro')).status).toBe(401);
        });

        test('sans compte PayDunya configuré pour Massla : 503 et aucune facture orpheline', async () => {
            getPaydunyaConfig.mockResolvedValue(null);
            const res = await post('/api/abonnement/passer-pro');
            expect(res.status).toBe(503);
            expect(await factures()).toHaveLength(0);
        });

        test('la ferme visée est toujours celle de la session (rien n’est lu dans le corps)', async () => {
            const autre = await creerOrganisation(pool, 'Autre ferme');
            await definirOffre(autre, 'ESSAI');
            await post('/api/abonnement/passer-pro', { tenant_id: autre });
            const chez = await pool.query(`SELECT tenant_id FROM factures_saas`);
            expect(chez.rows.map((r) => r.tenant_id)).toEqual([tenantFerme]);
        });
    });

    describe('« Parler à un conseiller » — demande enregistrée', () => {
        test('enregistre une demande « pro » liée à la ferme, avec son numéro', async () => {
            await pool.query(`UPDATE utilisateurs SET telephone = '+221771110000' WHERE nom_complet = 'Awa Ndiaye'`);
            const res = await post('/api/abonnement/demande-pro');
            expect(res.status).toBe(201);
            const { rows } = await pool.query(`SELECT * FROM demandes_contact`);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ source: 'pro', tenant_id: tenantFerme, nom: 'Awa Ndiaye', nom_ferme: 'Ganaar Boumak', whatsapp: '+221771110000', traitee: false });
        });

        test('des clics répétés ne remplissent pas la liste : une seule demande à rappeler par ferme', async () => {
            await post('/api/abonnement/demande-pro');
            const second = await post('/api/abonnement/demande-pro');
            expect(second.body.dejaEnregistree).toBe(true);
            expect((await pool.query(`SELECT COUNT(*)::int AS n FROM demandes_contact`)).rows[0].n).toBe(1);
        });

        test('une fois traitée, une nouvelle demande peut être enregistrée', async () => {
            await post('/api/abonnement/demande-pro');
            await pool.query(`UPDATE demandes_contact SET traitee = TRUE`);
            expect((await post('/api/abonnement/demande-pro')).status).toBe(201);
            expect((await pool.query(`SELECT COUNT(*)::int AS n FROM demandes_contact`)).rows[0].n).toBe(2);
        });

        test('une ferme déjà Pro n’a pas de demande à faire (409)', async () => {
            await pool.query(`UPDATE organisation_abonnement_saas SET plan = 'PRO'`);
            expect((await post('/api/abonnement/demande-pro')).status).toBe(409);
        });

        test('/me expose ce qu’il faut au bandeau : nom de la ferme, état du paiement en ligne et prix', async () => {
            const me = (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)).body.utilisateur;
            expect(me.organisationNom).toBe('Ganaar Boumak');
            expect(me.offre).toMatchObject({ plan: 'ESSAI', enLigne: true, prixMensuel: 10000 });
            delete process.env.PASSAGE_PRO_EN_LIGNE_ACTIF;
            const ferme = (await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenAdmin}`)).body.utilisateur;
            expect(ferme.offre.enLigne).toBe(false);
        });
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');
const { lancerRelancesAuto, dansFenetreEnvoi, MAX_TENTATIVES } = require('../src/relancesAuto');
const { setWhatsappConfig } = require('../src/whatsappConfig');

jest.mock('../src/whatsapp');
const { envoyerMessageWhatsapp } = require('../src/whatsapp');

const MAINTENANT = new Date('2026-09-19T10:00:00Z');
const JOUR_MS = 24 * 3600 * 1000;
const jourIso = (deltaJours) => new Date(MAINTENANT.getTime() + deltaJours * JOUR_MS).toISOString().slice(0, 10);

describe('relances automatiques J+7 — factures clients impayées', () => {
    let compteurCommande = 0;
    let pool;
    let envoyer;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        envoyer = jest.fn().mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
    });

    afterEach(async () => {
        await pool.end();
    });

    /** Ferme cliente normale, avec sa propre config WhatsApp (sauf si `avecConfig: false`). */
    async function creerFerme({ nom = 'Ferme Test', avecConfig = true, plateforme = false, modules = null, abonnementActif = true } = {}) {
        const id = await creerOrganisation(pool, nom);
        if (plateforme) await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [id]);
        if (avecConfig && !plateforme) await setWhatsappConfig(pool, id, { accessToken: 'jeton', phoneNumberId: '123' }, null);
        if (modules) {
            await pool.query(`INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif) VALUES ($1, $2, 25000, $3)`, [
                id,
                modules,
                abonnementActif,
            ]);
        }
        return id;
    }

    /** Facture impayée dont l'échéance est à `joursEcheance` jours dans le passé. */
    async function creerFacture(tenantId, { joursEcheance = 7, statut = 'EN_RETARD', montant = 5000, statutCommande = 'LIVREE', telephone, extra = '' } = {}) {
        const client = await creerClient(pool, { tenant_id: tenantId, ...(telephone !== undefined ? { telephone } : {}) });
        const commande = await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, `CMD-R-${++compteurCommande}`, client.id, statutCommande, montant]
        );
        const facture = await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, commande.rows[0].id, jourIso(-joursEcheance), statut, montant]
        );
        if (extra) await pool.query(`UPDATE factures SET ${extra} WHERE id = $1`, [facture.rows[0].id]);
        return { id: facture.rows[0].id, telephone: client.telephone };
    }

    const balayer = () => lancerRelancesAuto(pool, { maintenant: MAINTENANT, envoyer, globalConfigure: () => true });

    describe('éligibilité selon la date', () => {
        test.each([
            [6, false],
            [7, true],
            [14, true],
            [21, true],
            [22, false],
        ])('facture échue depuis %i jours -> relancée : %s', async (jours, attendu) => {
            const ferme = await creerFerme();
            await creerFacture(ferme, { joursEcheance: jours });

            const bilan = await balayer();

            expect(bilan.envoyees).toBe(attendu ? 1 : 0);
            expect(envoyer).toHaveBeenCalledTimes(attendu ? 1 : 0);
        });
    });

    test('envoie au téléphone du client avec le montant restant et les identifiants de LA ferme', async () => {
        const ferme = await creerFerme();
        const facture = await creerFacture(ferme, { montant: 12500 });

        await balayer();

        expect(envoyer).toHaveBeenCalledWith(
            facture.telephone,
            expect.objectContaining({ montant: 12500, config: expect.objectContaining({ accessToken: 'jeton', phoneNumberId: '123' }) })
        );
    });

    test("trace l'envoi dans le journal d'audit (sans utilisateur) et pose les horodatages", async () => {
        const ferme = await creerFerme();
        const facture = await creerFacture(ferme);

        await balayer();

        const audit = await pool.query(`SELECT * FROM audit_logs WHERE action = 'RAPPEL_WHATSAPP_AUTO'`);
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0].tenant_id).toBe(ferme);
        expect(audit.rows[0].utilisateur_id).toBeNull();
        const f = (await pool.query(`SELECT rappel_auto_envoye_le, dernier_rappel_le FROM factures WHERE id = $1`, [facture.id])).rows[0];
        expect(f.rappel_auto_envoye_le).not.toBeNull();
        expect(f.dernier_rappel_le).not.toBeNull();
    });

    test('une facture partiellement payée mais en retard est relancée', async () => {
        const ferme = await creerFerme();
        await creerFacture(ferme, { statut: 'PAYEE_PARTIEL', montant: 2000 });
        expect((await balayer()).envoyees).toBe(1);
    });

    describe('factures jamais relancées', () => {
        test.each([
            ['déjà payée', { statut: 'PAYEE', montant: 0 }],
            ['montant restant nul', { montant: 0 }],
            ['commande annulée', { statutCommande: 'ANNULEE' }],
            ['client sans téléphone', { telephone: '' }],
            ['relance manuelle il y a 1 jour', { extra: `dernier_rappel_le = '${jourIso(-1)} 08:00:00'` }],
            ['relance automatique déjà envoyée', { extra: `rappel_auto_envoye_le = '${jourIso(-1)} 08:00:00'` }],
            ['3 tentatives déjà échouées', { extra: `rappel_auto_tentatives = ${MAX_TENTATIVES}` }],
        ])('%s', async (_nom, options) => {
            const ferme = await creerFerme();
            await creerFacture(ferme, options);

            const bilan = await balayer();

            expect(bilan.envoyees).toBe(0);
            expect(envoyer).not.toHaveBeenCalled();
        });

        test('une relance manuelle de plus de 3 jours ne bloque pas la relance automatique', async () => {
            const ferme = await creerFerme();
            await creerFacture(ferme, { extra: `dernier_rappel_le = '${jourIso(-5)} 08:00:00'` });
            expect((await balayer()).envoyees).toBe(1);
        });
    });

    describe('éligibilité de la ferme', () => {
        test('sans configuration WhatsApp propre, la ferme est ignorée (jamais les identifiants de Massla)', async () => {
            const ferme = await creerFerme({ avecConfig: false });
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(0);
            expect(envoyer).not.toHaveBeenCalled();
        });

        test('Ferme Massla (plateforme) utilise les identifiants globaux : config undefined', async () => {
            const massla = await creerFerme({ nom: 'Ferme Massla', plateforme: true });
            const facture = await creerFacture(massla);

            await balayer();

            expect(envoyer).toHaveBeenCalledWith(facture.telephone, { config: undefined, montant: 5000 });
        });

        test("Ferme Massla est ignorée si les identifiants globaux ne sont pas configurés", async () => {
            const massla = await creerFerme({ nom: 'Ferme Massla', plateforme: true });
            await creerFacture(massla);

            const bilan = await lancerRelancesAuto(pool, { maintenant: MAINTENANT, envoyer, globalConfigure: () => false });

            expect(bilan.envoyees).toBe(0);
            expect(envoyer).not.toHaveBeenCalled();
        });

        test("l'interrupteur de la ferme coupe les relances", async () => {
            const ferme = await creerFerme();
            await pool.query(`UPDATE organisations SET relances_auto_actives = FALSE WHERE id = $1`, [ferme]);
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(0);
        });

        test('une ferme supprimée est ignorée', async () => {
            const ferme = await creerFerme();
            await pool.query(`UPDATE organisations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [ferme]);
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(0);
        });

        test('abonnement suspendu : aucune relance', async () => {
            const ferme = await creerFerme({ modules: ['pack_tout_compris'], abonnementActif: false });
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(0);
        });

        test('Socle Essentiel seul (sans module Finance) : aucune relance', async () => {
            const ferme = await creerFerme({ modules: [] });
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(0);
        });

        test('module Finance souscrit : relance envoyée', async () => {
            const ferme = await creerFerme({ modules: ['finance'] });
            await creerFacture(ferme);

            expect((await balayer()).envoyees).toBe(1);
        });

        test('les fermes sont traitées séparément avec leurs propres identifiants', async () => {
            const a = await creerFerme({ nom: 'Ferme A' });
            const b = await creerFerme({ nom: 'Ferme B' });
            await setWhatsappConfig(pool, b, { accessToken: 'jeton-b', phoneNumberId: '456' }, null);
            const factureA = await creerFacture(a);
            const factureB = await creerFacture(b);

            const bilan = await balayer();

            expect(bilan.envoyees).toBe(2);
            expect(envoyer).toHaveBeenCalledWith(factureA.telephone, expect.objectContaining({ config: expect.objectContaining({ accessToken: 'jeton' }) }));
            expect(envoyer).toHaveBeenCalledWith(factureB.telephone, expect.objectContaining({ config: expect.objectContaining({ accessToken: 'jeton-b' }) }));
        });
    });

    describe('idempotence et échecs', () => {
        test('un second balayage ne renvoie rien (une seule relance auto par facture)', async () => {
            const ferme = await creerFerme();
            await creerFacture(ferme);

            await balayer();
            const second = await balayer();

            expect(second.envoyees).toBe(0);
            expect(envoyer).toHaveBeenCalledTimes(1);
        });

        test("deux balayages simultanés n'envoient qu'un seul message", async () => {
            const ferme = await creerFerme();
            await creerFacture(ferme);

            await Promise.all([balayer(), balayer()]);

            expect(envoyer).toHaveBeenCalledTimes(1);
        });

        test('un échec lève la réservation et compte une tentative ; la facture sera retentée', async () => {
            const ferme = await creerFerme();
            const facture = await creerFacture(ferme);
            envoyer.mockRejectedValueOnce(new Error('Jeton expiré'));
            jest.spyOn(console, 'error').mockImplementation(() => {});

            const premier = await balayer();
            const enBase = (await pool.query(`SELECT rappel_auto_envoye_le, rappel_auto_tentatives FROM factures WHERE id = $1`, [facture.id])).rows[0];
            const second = await balayer();

            expect(premier).toMatchObject({ envoyees: 0, echecs: 1 });
            expect(enBase.rappel_auto_envoye_le).toBeNull();
            expect(enBase.rappel_auto_tentatives).toBe(1);
            expect(second.envoyees).toBe(1);
        });

        test(`après ${MAX_TENTATIVES} échecs, la facture n'est plus tentée`, async () => {
            const ferme = await creerFerme();
            await creerFacture(ferme);
            envoyer.mockRejectedValue(new Error('Numéro invalide'));
            jest.spyOn(console, 'error').mockImplementation(() => {});

            for (let i = 0; i < MAX_TENTATIVES + 2; i++) await balayer();

            expect(envoyer).toHaveBeenCalledTimes(MAX_TENTATIVES);
        });

        test("l'échec d'une facture n'empêche pas les suivantes", async () => {
            const ferme = await creerFerme();
            await creerFacture(ferme, { joursEcheance: 10 });
            await creerFacture(ferme, { joursEcheance: 8 });
            envoyer.mockRejectedValueOnce(new Error('Erreur ponctuelle'));
            jest.spyOn(console, 'error').mockImplementation(() => {});

            const bilan = await balayer();

            expect(bilan).toMatchObject({ envoyees: 1, echecs: 1 });
        });
    });

    test("la fenêtre d'envoi est 9 h–18 h UTC", () => {
        expect(dansFenetreEnvoi(new Date('2026-09-19T08:59:00Z'))).toBe(false);
        expect(dansFenetreEnvoi(new Date('2026-09-19T09:00:00Z'))).toBe(true);
        expect(dansFenetreEnvoi(new Date('2026-09-19T17:59:00Z'))).toBe(true);
        expect(dansFenetreEnvoi(new Date('2026-09-19T18:00:00Z'))).toBe(false);
        expect(dansFenetreEnvoi(new Date('2026-09-19T03:00:00Z'))).toBe(false);
    });
});

describe('relances automatiques — routes (rappel manuel et interrupteur)', () => {
    let pool;
    let app;
    let tenantId;
    let tokenAdmin;
    let tokenComptable;

    beforeEach(async () => {
        jest.clearAllMocks();
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [tenantId]);
        tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        tokenComptable = await creerUtilisateurEtToken(pool, { role: 'comptable', tenant_id: tenantId });
        app = buildApp(pool, ['finance', 'parametres-whatsapp']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un rappel manuel réussi pose dernier_rappel_le (évite le doublon automatique)', async () => {
        envoyerMessageWhatsapp.mockResolvedValue({ messages: [{ id: 'wamid.test' }] });
        const client = await creerClient(pool, { tenant_id: tenantId });
        const commande = await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, 'CMD-M', $2, 'LIVREE', 5000) RETURNING id`,
            [tenantId, client.id]
        );
        const facture = await pool.query(
            `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, CURRENT_DATE, 'A_PAYER', 5000) RETURNING id`,
            [tenantId, commande.rows[0].id]
        );

        const res = await request(app).post(`/api/finance/factures/${facture.rows[0].id}/rappel-whatsapp`).set('Authorization', `Bearer ${tokenComptable}`);

        expect(res.status).toBe(200);
        const f = (await pool.query(`SELECT dernier_rappel_le FROM factures WHERE id = $1`, [facture.rows[0].id])).rows[0];
        expect(f.dernier_rappel_le).not.toBeNull();
    });

    test("GET /parametres-whatsapp expose l'état de l'interrupteur (activé par défaut)", async () => {
        const res = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(res.status).toBe(200);
        expect(res.body.relancesAutoActives).toBe(true);
    });

    test("l'admin peut couper puis réactiver les relances automatiques", async () => {
        const coupe = await request(app).put('/api/parametres-whatsapp/relances-auto').set('Authorization', `Bearer ${tokenAdmin}`).send({ actives: false });
        expect(coupe.status).toBe(200);
        expect(coupe.body.relancesAutoActives).toBe(false);
        expect((await pool.query(`SELECT relances_auto_actives FROM organisations WHERE id = $1`, [tenantId])).rows[0].relances_auto_actives).toBe(false);

        const lecture = await request(app).get('/api/parametres-whatsapp').set('Authorization', `Bearer ${tokenAdmin}`);
        expect(lecture.body.relancesAutoActives).toBe(false);

        const reactive = await request(app).put('/api/parametres-whatsapp/relances-auto').set('Authorization', `Bearer ${tokenAdmin}`).send({ actives: true });
        expect(reactive.body.relancesAutoActives).toBe(true);
    });

    test('valeur non booléenne refusée', async () => {
        const res = await request(app).put('/api/parametres-whatsapp/relances-auto').set('Authorization', `Bearer ${tokenAdmin}`).send({ actives: 'oui' });
        expect(res.status).toBe(400);
    });

    test("un non-admin ne peut pas changer l'interrupteur", async () => {
        const res = await request(app).put('/api/parametres-whatsapp/relances-auto').set('Authorization', `Bearer ${tokenComptable}`).send({ actives: false });
        expect(res.status).toBe(403);
    });
});

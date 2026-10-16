const { createTestPool, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');
const { lancerRappelsFinEssai, MAX_TENTATIVES } = require('../src/rappelFinEssai');

const JOUR_MS = 24 * 3600 * 1000;

describe("rappel J-3 de fin d'essai gratuit par WhatsApp", () => {
    let pool;
    let envoyer;
    const dispo = () => true;
    const maintenant = new Date('2026-10-20T10:00:00Z');

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        envoyer = jest.fn().mockResolvedValue({});
    });
    afterEach(async () => {
        await pool.end();
    });

    /** Ferme d'essai à `joursRestants` jours de sa fin, avec un gérant (numéro confirmé ou non). */
    async function essai(nom, telephone, joursRestants, { verifie = true, plan = 'ESSAI', actif = true, convertiPro = false, supprimee = false } = {}) {
        const tenant = await creerOrganisation(pool, nom);
        if (supprimee) await pool.query(`UPDATE organisations SET deleted_at = now() WHERE id = $1`, [tenant]);
        const role = (await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`)).rows[0].id;
        await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, telephone, telephone_verifie) VALUES ($1, 'Gérant', NULL, 'x', $2, $3, $4)`,
            [tenant, role, telephone, verifie]
        );
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif, plan, essai_debut_le, essai_fin_le, converti_pro_le)
             VALUES ($1, '{}', 0, $2, $3, $4, $5, $6)`,
            [tenant, actif, plan, new Date(maintenant.getTime() - 20 * JOUR_MS), new Date(maintenant.getTime() + joursRestants * JOUR_MS), convertiPro ? maintenant : null]
        );
        return tenant;
    }
    const ligne = async (tenant) => (await pool.query(`SELECT rappel_fin_essai_envoye_le, rappel_fin_essai_tentatives FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenant])).rows[0];
    const lancer = (options = {}) => lancerRappelsFinEssai(pool, { maintenant, envoyer, disponible: dispo, ...options });

    beforeEach(() => {
        process.env.WHATSAPP_TEMPLATE_J3_NOM = 'fin_essai_j3';
    });
    afterEach(() => {
        delete process.env.WHATSAPP_TEMPLATE_J3_NOM;
    });

    test("envoie UN rappel à l'essai qui se termine dans 3 jours, avec le modèle dédié et le nombre de jours", async () => {
        const t = await essai('Essai J-3', '+221770000001', 2.5);
        const bilan = await lancer();
        expect(bilan).toEqual({ envoyes: 1, echecs: 0 });
        expect(envoyer).toHaveBeenCalledTimes(1);
        const [numero, options] = envoyer.mock.calls[0];
        expect(numero).toBe('+221770000001');
        expect(options.modele).toEqual({ nom: 'fin_essai_j3', langue: 'fr' });
        expect(options.composants[0].parameters[0].text).toBe('3'); // 2,5 jours restants → « 3 jours »
        expect((await ligne(t)).rappel_fin_essai_envoye_le).not.toBeNull();
    });

    test("jamais deux fois : un second balayage ne renvoie rien", async () => {
        await essai('Essai J-3', '+221770000002', 2);
        await lancer();
        const second = await lancer();
        expect(second).toEqual({ envoyes: 0, echecs: 0 });
        expect(envoyer).toHaveBeenCalledTimes(1);
    });

    test("n'envoie pas : trop tôt, déjà terminé, numéro jamais confirmé, converti en Pro, abonnement suspendu, ferme supprimée", async () => {
        await essai('Trop tôt', '+221770000003', 10);
        await essai('Déjà terminé', '+221770000004', -1);
        await essai('Numéro non confirmé', '+221770000005', 2, { verifie: false });
        await essai('Converti', '+221770000006', 2, { plan: 'PRO', convertiPro: true });
        await essai('Suspendu', '+221770000007', 2, { actif: false });
        await essai('Supprimée', '+221770000008', 2, { supprimee: true });
        expect(await lancer()).toEqual({ envoyes: 0, echecs: 0 });
        expect(envoyer).not.toHaveBeenCalled();
    });

    test("un échec lève la réservation et compte une tentative ; le balayage suivant réessaie, puis le plafond arrête", async () => {
        const t = await essai('Essai capricieux', '+221770000009', 2);
        envoyer.mockRejectedValue(new Error('WhatsApp indisponible'));
        const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});

        for (let i = 1; i <= MAX_TENTATIVES; i += 1) {
            expect(await lancer()).toEqual({ envoyes: 0, echecs: 1 });
            const l = await ligne(t);
            expect(l.rappel_fin_essai_envoye_le).toBeNull();
            expect(l.rappel_fin_essai_tentatives).toBe(i);
        }
        // plafond atteint : plus aucune tentative
        expect(await lancer()).toEqual({ envoyes: 0, echecs: 0 });
        expect(envoyer).toHaveBeenCalledTimes(MAX_TENTATIVES);
        consoleErr.mockRestore();
    });

    test("fermé par défaut : sans interrupteur ni modèle, rien ne part et la base n'est même pas ouverte", async () => {
        await essai('Essai J-3', '+221770000010', 2);
        const connect = jest.spyOn(pool, 'connect');
        const bilan = await lancerRappelsFinEssai(pool, { maintenant, envoyer, disponible: () => false });
        expect(bilan).toEqual({ envoyes: 0, echecs: 0 });
        expect(envoyer).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
    });

    test("une seule personne prévenue par ferme, même avec plusieurs comptes confirmés", async () => {
        const t = await essai('Deux comptes', '+221770000011', 2);
        const role = (await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`)).rows[0].id;
        await pool.query(`INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, telephone, telephone_verifie) VALUES ($1, 'Second', NULL, 'x', $2, '+221770000012', TRUE)`, [t, role]);
        await lancer();
        expect(envoyer).toHaveBeenCalledTimes(1);
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

const JOUR_MS = 24 * 3600 * 1000;

describe('plateforme — panneau "Activité des fermes"', () => {
    let pool;
    let app;
    let massla;
    let tokenSuperviseur;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        massla = await creerOrganisation(pool, 'Ferme Massla');
        await pool.query(`UPDATE organisations SET est_plateforme = TRUE WHERE id = $1`, [massla]);
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: massla, estSuperviseurPlateforme: true });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    /** Écrit une ligne du journal d'audit datée de `joursAvant` jours. */
    async function journal(tenantId, table, action, joursAvant, { impersonation = false, utilisateurId = null, details = null } = {}) {
        await pool.query(
            `INSERT INTO audit_logs (tenant_id, table_name, action, utilisateur_id, impersonation, details, cree_le) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tenantId, table, action, utilisateurId, impersonation, details, new Date(Date.now() - joursAvant * JOUR_MS)]
        );
    }

    async function utilisateurDe(tenantId) {
        await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        const res = await pool.query(`SELECT id FROM utilisateurs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [tenantId]);
        return res.rows[0].id;
    }

    const lire = async () => {
        const res = await request(app).get('/api/plateforme/activite').set('Authorization', `Bearer ${tokenSuperviseur}`);
        expect(res.status).toBe(200);
        return Object.fromEntries(res.body.fermes.map((f) => [f.nom, f]));
    };

    test('un admin sans le flag superviseur reçoit 403', async () => {
        const ferme = await creerOrganisation(pool, 'Ferme X');
        const token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: ferme });
        const res = await request(app).get('/api/plateforme/activite').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    test('classe chaque ferme : active, connectée sans saisir, inactive, jamais connectée', async () => {
        const active = await creerOrganisation(pool, 'Ferme Active');
        const sansSaisie = await creerOrganisation(pool, 'Ferme Sans Saisie');
        const inactive = await creerOrganisation(pool, 'Ferme Inactive');
        await creerOrganisation(pool, 'Ferme Jamais');

        await journal(active, 'utilisateurs', 'LOGIN', 1);
        await journal(active, 'lots_production', 'CREATE', 1);
        await journal(sansSaisie, 'utilisateurs', 'LOGIN', 2);
        await journal(inactive, 'utilisateurs', 'LOGIN', 12);
        await journal(inactive, 'lots_production', 'CREATE', 12);

        const fermes = await lire();

        expect(fermes['Ferme Active'].statut).toBe('active');
        expect(fermes['Ferme Sans Saisie'].statut).toBe('connecte_sans_saisie');
        expect(fermes['Ferme Inactive'].statut).toBe('inactive');
        expect(fermes['Ferme Jamais'].statut).toBe('jamais');
        expect(fermes['Ferme Jamais'].derniere_connexion).toBeNull();
    });

    test('compte les saisies métier sur 7 et 30 jours, sans les réglages ni les comptes', async () => {
        const ferme = await creerOrganisation(pool, 'Ferme Compteurs');
        await journal(ferme, 'utilisateurs', 'LOGIN', 0);
        await journal(ferme, 'releves_journaliers', 'CREATE', 0);
        await journal(ferme, 'releves_journaliers', 'CREATE', 2);
        await journal(ferme, 'commandes', 'CREATE', 3);
        await journal(ferme, 'lots_production', 'UPDATE', 20); // dans les 30 j mais pas dans les 7 j
        // Ne comptent PAS comme saisies :
        await journal(ferme, 'utilisateurs', 'UPDATE', 1); // gestion des comptes
        await journal(ferme, 'organisation_whatsapp_config', 'UPDATE', 1); // réglage
        await journal(ferme, 'factures', 'RAPPEL_WHATSAPP', 1); // action non-écriture
        await journal(ferme, 'lots_production', 'CREATE', 45); // au-delà de 30 j

        const f = (await lire())['Ferme Compteurs'];

        expect(f.saisies_7j).toBe(3);
        expect(f.saisies_30j).toBe(4);
        expect(f.principales_saisies_7j).toEqual([
            { table: 'releves_journaliers', n: 2 },
            { table: 'commandes', n: 1 },
        ]);
    });

    test('compte les jours distincts avec saisie et les utilisateurs distincts connectés', async () => {
        const ferme = await creerOrganisation(pool, 'Ferme Jours');
        const u1 = await utilisateurDe(ferme);
        const u2 = await utilisateurDe(ferme);
        await journal(ferme, 'utilisateurs', 'LOGIN', 0, { utilisateurId: u1 });
        await journal(ferme, 'utilisateurs', 'LOGIN', 0, { utilisateurId: u1 });
        await journal(ferme, 'utilisateurs', 'LOGIN', 1, { utilisateurId: u2 });
        await journal(ferme, 'commandes', 'CREATE', 0);
        await journal(ferme, 'commandes', 'CREATE', 0);
        await journal(ferme, 'commandes', 'CREATE', 2);

        const f = (await lire())['Ferme Jours'];

        expect(f.connexions_7j).toBe(3);
        expect(f.utilisateurs_connectes_7j).toBe(2);
        expect(f.jours_actifs_7j).toBe(2);
    });

    test("les actions de support (impersonation) ne comptent jamais comme de l'activité du client", async () => {
        const ferme = await creerOrganisation(pool, 'Ferme Support');
        await journal(ferme, 'utilisateurs', 'LOGIN', 0, { impersonation: true });
        await journal(ferme, 'commandes', 'CREATE', 0, { impersonation: true });

        const f = (await lire())['Ferme Support'];

        expect(f.statut).toBe('jamais');
        expect(f.saisies_7j).toBe(0);
        expect(f.connexions_7j).toBe(0);
    });

    test("la facturation SaaS faite par Massla n'est pas une saisie du client", async () => {
        const ferme = await creerOrganisation(pool, 'Ferme Facturée');
        await journal(ferme, 'utilisateurs', 'LOGIN', 20);
        await journal(ferme, 'factures_saas', 'CREATE', 0);
        await journal(ferme, 'factures_saas', 'UPDATE', 1);

        const f = (await lire())['Ferme Facturée'];

        expect(f.saisies_7j).toBe(0);
        expect(f.saisies_30j).toBe(0);
        expect(f.statut).toBe('inactive');
    });

    test("n'expose que des compteurs : jamais le contenu d'une saisie", async () => {
        const ferme = await creerOrganisation(pool, 'Ferme Discrète');
        await journal(ferme, 'clients', 'CREATE', 0, { details: JSON.stringify({ nom: 'Fatou', telephone: '+221771234567' }) });

        const res = await request(app).get('/api/plateforme/activite').set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(JSON.stringify(res.body)).not.toContain('Fatou');
        expect(JSON.stringify(res.body)).not.toContain('+221771234567');
    });

    test('exclut Ferme Massla et les fermes supprimées', async () => {
        const supprimee = await creerOrganisation(pool, 'Ferme Supprimée');
        await pool.query(`UPDATE organisations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [supprimee]);
        await creerOrganisation(pool, 'Ferme Cliente');

        const fermes = await lire();

        expect(Object.keys(fermes)).toEqual(['Ferme Cliente']);
    });

    test("renvoie l'abonnement quand il existe, sinon null", async () => {
        const abonnee = await creerOrganisation(pool, 'Ferme Abonnée');
        await creerOrganisation(pool, 'Ferme Sans Abonnement');
        await pool.query(`INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif) VALUES ($1, '{}', 25000, TRUE)`, [abonnee]);

        const fermes = await lire();

        expect(fermes['Ferme Abonnée'].abonnement).toEqual({ actif: true, montant_mensuel: 25000 });
        expect(fermes['Ferme Sans Abonnement'].abonnement).toBeNull();
    });

    test('trie les fermes qui demandent une action en premier', async () => {
        const active = await creerOrganisation(pool, 'A Active');
        const inactive = await creerOrganisation(pool, 'B Inactive');
        await creerOrganisation(pool, 'C Jamais');
        const sansSaisie = await creerOrganisation(pool, 'D Sans Saisie');
        await journal(active, 'utilisateurs', 'LOGIN', 0);
        await journal(active, 'commandes', 'CREATE', 0);
        await journal(inactive, 'utilisateurs', 'LOGIN', 15);
        await journal(sansSaisie, 'utilisateurs', 'LOGIN', 1);

        const res = await request(app).get('/api/plateforme/activite').set('Authorization', `Bearer ${tokenSuperviseur}`);

        expect(res.body.fermes.map((f) => f.nom)).toEqual(['C Jamais', 'B Inactive', 'D Sans Saisie', 'A Active']);
    });
});

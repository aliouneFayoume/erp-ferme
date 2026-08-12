const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Audit sécurité 2026-08-11 (E4, 3e point) : avant ce correctif, seules les entrées
// CONNEXION_SUPPORT/FIN_SUPPORT montraient qu'une session de support avait eu lieu — toute action
// faite PENDANT la session (ex: modifier un compte) était indiscernable d'une action normale de
// l'admin de la ferme cible. logAudit() propage désormais le marqueur automatiquement.
describe('audit — marqueur d\'impersonation propagé à chaque écriture', () => {
    let pool;
    let app;
    let tenantSuperviseur;
    let tenantCible;
    let tokenSuperviseur;
    let superviseurId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantSuperviseur = await creerOrganisation(pool, 'Ferme Superviseur');
        tenantCible = await creerOrganisation(pool, 'Ferme Cible');
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantSuperviseur, estSuperviseurPlateforme: true });
        superviseurId = require('jsonwebtoken').decode(tokenSuperviseur).id;
        app = buildApp(pool, ['plateforme', 'utilisateurs']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('une écriture faite via un token d\'impersonation porte impersonation=true et le bon superviseur_id', async () => {
        await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantCible, nom_complet: 'Admin Cible' });
        const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = 'comptable'`);
        const cibleRes = await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif) VALUES ($1, 'Employe Test', 'employe@cible.sn', 'x', $2, TRUE) RETURNING id`,
            [tenantCible, roleRes.rows[0].id]
        );
        const cibleId = cibleRes.rows[0].id;

        const connexion = await request(app)
            .post(`/api/plateforme/organisations/${tenantCible}/se-connecter-admin`)
            .set('Authorization', `Bearer ${tokenSuperviseur}`);
        const tokenImpersonation = connexion.body.token;

        const res = await request(app)
            .put(`/api/utilisateurs/${cibleId}`)
            .set('Authorization', `Bearer ${tokenImpersonation}`)
            .send({ nom_complet: 'Employe Renommé' });
        expect(res.status).toBe(200);

        const audit = await pool.query(
            `SELECT impersonation, superviseur_id FROM audit_logs WHERE tenant_id = $1 AND table_name = 'utilisateurs' AND row_id = $2 AND action = 'UPDATE'`,
            [tenantCible, cibleId]
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0].impersonation).toBe(true);
        expect(audit.rows[0].superviseur_id).toBe(superviseurId);
    });

    test('une écriture normale (hors impersonation) porte impersonation=false et superviseur_id NULL', async () => {
        const tokenAdmin = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantCible });
        const roleRes = await pool.query(`SELECT id FROM roles WHERE nom = 'comptable'`);
        const cibleRes = await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif) VALUES ($1, 'Employe Normal', 'employe-normal@cible.sn', 'x', $2, TRUE) RETURNING id`,
            [tenantCible, roleRes.rows[0].id]
        );
        const cibleId = cibleRes.rows[0].id;

        const res = await request(app)
            .put(`/api/utilisateurs/${cibleId}`)
            .set('Authorization', `Bearer ${tokenAdmin}`)
            .send({ nom_complet: 'Employe Renommé Normal' });
        expect(res.status).toBe(200);

        const audit = await pool.query(
            `SELECT impersonation, superviseur_id FROM audit_logs WHERE tenant_id = $1 AND table_name = 'utilisateurs' AND row_id = $2 AND action = 'UPDATE'`,
            [tenantCible, cibleId]
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0].impersonation).toBe(false);
        expect(audit.rows[0].superviseur_id).toBeNull();
    });
});

const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('plateforme — nettoyage des essais autonomes jamais confirmés', () => {
    let pool;
    let app;
    let token;
    let tenantPlateforme;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantPlateforme = await creerOrganisation(pool, 'Ferme Massla');
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantPlateforme, estSuperviseurPlateforme: true });
        app = buildApp(pool, ['plateforme']);
    });

    afterEach(async () => {
        await pool.end();
    });

    /** Ferme d'essai telle que la crée l'inscription autonome : un gérant avec téléphone et sans e-mail. */
    async function creerEssai({ nom, telephone, ilYaJours, verifie = false, plan = 'ESSAI', avecEmail = false, convertiPro = false }) {
        const tenant = await creerOrganisation(pool, nom);
        await pool.query(`UPDATE organisations SET cree_le = $1 WHERE id = $2`, [new Date(Date.now() - ilYaJours * 86400000), tenant]);
        const role = (await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`)).rows[0].id;
        await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, telephone, telephone_verifie)
             VALUES ($1, 'Gérant', $2, 'x', $3, $4, $5)`,
            [tenant, avecEmail ? `${telephone.replace('+', '')}@ferme.sn` : null, role, telephone, verifie]
        );
        await pool.query(
            `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, actif, plan, essai_debut_le, essai_fin_le, converti_pro_le)
             VALUES ($1, '{}', 0, TRUE, $2, now(), now() + interval '30 days', $3)`,
            [tenant, plan, convertiPro ? new Date() : null]
        );
        return tenant;
    }
    const lister = (jours) => request(app).get(`/api/plateforme/essais-non-confirmes${jours ? `?jours=${jours}` : ''}`).set('Authorization', `Bearer ${token}`);
    const nettoyer = (corps = {}) => request(app).post('/api/plateforme/essais-non-confirmes/nettoyer').set('Authorization', `Bearer ${token}`).send(corps);
    const supprimee = async (tenant) => (await pool.query(`SELECT deleted_at FROM organisations WHERE id = $1`, [tenant])).rows[0].deleted_at !== null;

    test('liste puis supprime (doucement) les essais jamais confirmés de plus de 7 jours, avec une trace', async () => {
        const vieux = await creerEssai({ nom: 'Essai fantôme', telephone: '+221770000001', ilYaJours: 10 });

        const liste = await lister();
        expect(liste.status).toBe(200);
        expect(liste.body.jours).toBe(7);
        expect(liste.body.fermes.map((f) => f.nom)).toEqual(['Essai fantôme']);
        expect(liste.body.fermes[0]).toMatchObject({ telephone: '+221770000001', jours: 10 });

        const res = await nettoyer();
        expect(res.status).toBe(200);
        expect(res.body.supprimees).toBe(1);
        expect(await supprimee(vieux)).toBe(true);
        const audit = await pool.query(`SELECT details FROM audit_logs WHERE table_name = 'organisations' AND action = 'DELETE' AND row_id = $1`, [vieux]);
        expect(audit.rows).toHaveLength(1);
        expect(JSON.stringify(audit.rows[0].details)).toContain('essai_autonome_non_confirme');

        // une fois supprimée, elle n'apparaît plus
        expect((await lister()).body.fermes).toEqual([]);
    });

    test("ne touche jamais : essai récent, numéro confirmé, ferme convertie en Pro, ferme sur mesure, compte avec e-mail, ferme plateforme", async () => {
        const recent = await creerEssai({ nom: 'Récent', telephone: '+221770000002', ilYaJours: 2 });
        const confirme = await creerEssai({ nom: 'Confirmé', telephone: '+221770000003', ilYaJours: 30, verifie: true });
        const pro = await creerEssai({ nom: 'Converti', telephone: '+221770000004', ilYaJours: 30, plan: 'PRO', convertiPro: true });
        const avecEmail = await creerEssai({ nom: 'Avec e-mail', telephone: '+221770000005', ilYaJours: 30, avecEmail: true });
        const surMesure = await creerOrganisation(pool, 'Sur mesure');
        await pool.query(`UPDATE organisations SET cree_le = now() - interval '60 days' WHERE id = $1`, [surMesure]);
        await pool.query(`UPDATE organisations SET cree_le = now() - interval '60 days' WHERE id = $1`, [tenantPlateforme]);

        expect((await lister()).body.fermes).toEqual([]);
        const res = await nettoyer();
        expect(res.body.supprimees).toBe(0);
        for (const t of [recent, confirme, pro, avecEmail, surMesure, tenantPlateforme]) expect(await supprimee(t)).toBe(false);
    });

    test('le délai se règle (3 jours minimum) et un délai invalide est refusé sans rien supprimer', async () => {
        const quatreJours = await creerEssai({ nom: 'Quatre jours', telephone: '+221770000006', ilYaJours: 4 });
        expect((await lister()).body.fermes).toEqual([]); // 7 j par défaut : pas encore
        expect((await lister(3)).body.fermes.map((f) => f.nom)).toEqual(['Quatre jours']);

        expect((await lister(1)).status).toBe(400);
        expect((await nettoyer({ jours: 0 })).status).toBe(400);
        expect((await nettoyer({ jours: 'abc' })).status).toBe(400);
        expect(await supprimee(quatreJours)).toBe(false);

        expect((await nettoyer({ jours: 3 })).body.supprimees).toBe(1);
        expect(await supprimee(quatreJours)).toBe(true);
    });

    test("réservé au superviseur plateforme : un admin de ferme reçoit 403", async () => {
        const vieux = await creerEssai({ nom: 'Essai fantôme', telephone: '+221770000007', ilYaJours: 10 });
        const adminNormal = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantPlateforme, estSuperviseurPlateforme: false });
        const get = await request(app).get('/api/plateforme/essais-non-confirmes').set('Authorization', `Bearer ${adminNormal}`);
        const post = await request(app).post('/api/plateforme/essais-non-confirmes/nettoyer').set('Authorization', `Bearer ${adminNormal}`).send({});
        expect(get.status).toBe(403);
        expect(post.status).toBe(403);
        expect(await supprimee(vieux)).toBe(false);
    });
});

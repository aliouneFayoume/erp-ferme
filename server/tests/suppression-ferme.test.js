const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

jest.mock('../src/whatsapp');
jest.mock('../src/email', () => ({
    estConfigure: () => true,
    envoyerEmailVerification: jest.fn().mockResolvedValue({}),
    envoyerEmailRappelSaas: jest.fn(),
}));

describe('plateforme — supprimer une ferme « proprement » (libère e-mails, numéros et sous-domaine)', () => {
    let pool;
    let app;
    let massla;
    let ferme;
    let tokenSuperviseur;
    let tokenGerant;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        massla = await creerOrganisation(pool, 'Ferme Massla');
        ferme = await creerOrganisation(pool, 'Xidma Agro');
        await pool.query(`UPDATE organisations SET slug = 'xidma-agro' WHERE id = $1`, [ferme]);
        tokenSuperviseur = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: massla, estSuperviseurPlateforme: true });
        tokenGerant = await creerUtilisateurEtToken(pool, { role: 'admin', nom_complet: 'Gérant Xidma', tenant_id: ferme });
        await pool.query(`UPDATE utilisateurs SET email = 'xidma@exemple-reel.sn', telephone = '+221770001111' WHERE tenant_id = $1`, [ferme]);
        app = buildApp(pool, ['plateforme', 'auth']);
    });
    afterEach(async () => {
        await pool.end();
    });

    const supprimer = (id = ferme) => request(app).delete(`/api/plateforme/organisations/${id}`).set('Authorization', `Bearer ${tokenSuperviseur}`);
    const compte = async () => (await pool.query(`SELECT * FROM utilisateurs WHERE tenant_id = $1`, [ferme])).rows[0];

    test("libère l'adresse e-mail et le numéro : la personne peut se réinscrire avec les mêmes", async () => {
        expect((await supprimer()).status).toBe(204);
        const c = await compte();
        expect(c.email).toBe(`supprime-${c.id}@supprime.invalid`);
        expect(c.telephone).toBeNull();
        expect(c.deleted_at).not.toBeNull();
        expect(c.actif).toBe(false);

        // l'adresse d'origine est de nouveau utilisable par un autre compte (unicité plateforme)
        const autre = await creerOrganisation(pool, 'Nouvelle ferme');
        const role = (await pool.query(`SELECT id FROM roles WHERE nom = 'admin'`)).rows[0].id;
        await expect(
            pool.query(
                `INSERT INTO utilisateurs (tenant_id, nom_complet, email, telephone, mot_de_passe_hash, role_id) VALUES ($1, 'Revenu', 'xidma@exemple-reel.sn', '+221770001111', 'x', $2)`,
                [autre, role]
            )
        ).resolves.toBeDefined();
    });

    test("libère le sous-domaine, désactive l'abonnement et annule les factures encore à payer (les payées restent)", async () => {
        await pool.query(`INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, plan) VALUES ($1, '{}', 10000, 'PRO')`, [ferme]);
        await pool.query(`INSERT INTO factures_saas (tenant_id, type, periode, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', '2026-09', 10000, 'PAYEE', CURRENT_DATE)`, [ferme]);
        await pool.query(`INSERT INTO factures_saas (tenant_id, type, periode, montant, statut, date_echeance) VALUES ($1, 'ABONNEMENT', '2026-10', 10000, 'A_PAYER', CURRENT_DATE)`, [ferme]);

        await supprimer();

        const o = (await pool.query(`SELECT slug, deleted_at FROM organisations WHERE id = $1`, [ferme])).rows[0];
        expect(o.slug).toBeNull();
        expect(o.deleted_at).not.toBeNull();
        expect((await pool.query(`SELECT actif FROM organisation_abonnement_saas WHERE tenant_id = $1`, [ferme])).rows[0].actif).toBe(false);
        const statuts = (await pool.query(`SELECT periode, statut FROM factures_saas WHERE tenant_id = $1 ORDER BY periode`, [ferme])).rows;
        expect(statuts).toEqual([
            { periode: '2026-09', statut: 'PAYEE' },
            { periode: '2026-10', statut: 'ANNULEE' },
        ]);
    });

    test("les valeurs d'origine sont conservées dans le journal d'audit (rétablissement possible)", async () => {
        const avant = await compte();
        await supprimer();
        const ligne = (await pool.query(`SELECT details FROM audit_logs WHERE table_name = 'organisations' AND action = 'DELETE' AND row_id = $1`, [ferme])).rows[0];
        const d = typeof ligne.details === 'string' ? JSON.parse(ligne.details) : ligne.details;
        expect(d.slug_libere).toBe('xidma-agro');
        expect(d.comptes_liberes).toEqual([{ id: avant.id, email: 'xidma@exemple-reel.sn', telephone: '+221770001111' }]);
    });

    test("un compte d'essai sans e-mail (téléphone seul) est libéré aussi, sans violer la contrainte d'identifiant", async () => {
        await pool.query(`UPDATE utilisateurs SET email = NULL WHERE tenant_id = $1`, [ferme]);
        expect((await supprimer()).status).toBe(204);
        const c = await compte();
        expect(c.telephone).toBeNull();
        expect(c.email).toMatch(/@supprime\.invalid$/);
    });

    test("les sessions déjà ouvertes de la ferme sont coupées immédiatement", async () => {
        await supprimer();
        const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenGerant}`);
        expect(res.status).toBe(401);
    });

    test("ne touche jamais aux comptes des autres fermes", async () => {
        await supprimer();
        const supervis = await pool.query(`SELECT email, deleted_at FROM utilisateurs WHERE tenant_id = $1`, [massla]);
        expect(supervis.rows[0].deleted_at).toBeNull();
        expect(supervis.rows[0].email).not.toMatch(/supprime\.invalid/);
    });

    test("ferme déjà supprimée : 404 ; sa propre ferme : 400 ; non-superviseur : 403", async () => {
        await supprimer();
        expect((await supprimer()).status).toBe(404);
        expect((await supprimer(massla)).status).toBe(400);
        const adminSimple = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: massla, estSuperviseurPlateforme: false });
        expect((await request(app).delete(`/api/plateforme/organisations/${ferme}`).set('Authorization', `Bearer ${adminSimple}`)).status).toBe(403);
    });
});

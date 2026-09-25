const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Retour de Clovis (2026-09-24) : les bassins gardent leur type, ce sont les poissons (et leur espèce) qui passent
// d'un bassin à l'autre. Un déplacement ajuste l'effectif des deux bassins et l'espèce, et laisse une trace.
describe('production — déplacement de poissons entre bassins', () => {
    let pool;
    let app;
    let tenantId;
    let token;
    let piscicole;
    let eclosion;
    let larvaire;

    const creerSecteur = async (nom, parentId = null, tenant = tenantId) =>
        (await pool.query(`INSERT INTO secteurs (tenant_id, nom, parent_secteur_id) VALUES ($1, $2, $3) RETURNING id`, [tenant, nom, parentId])).rows[0].id;

    const creerBassin = async (secteurId, code, { effectif = 0, espece = null, statut = 'EN_COURS', tenant = tenantId } = {}) =>
        (
            await pool.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, espece)
                 VALUES ($1, $2, $3, $4, '2026-09-14', $5, $6) RETURNING id`,
                [tenant, secteurId, code, effectif, statut, espece]
            )
        ).rows[0].id;

    const deplacer = (corps, tokenUtilise = token) =>
        request(app).post('/api/production/mouvements').set('Authorization', `Bearer ${tokenUtilise}`).send({ date_mouvement: '2026-09-26', ...corps });

    const bassin = async (id) => (await pool.query(`SELECT quantite_initiale, espece FROM lots_production WHERE id = $1`, [id])).rows[0];
    const mouvements = async () => (await pool.query(`SELECT * FROM mouvements_bassins ORDER BY id`)).rows;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        piscicole = await creerSecteur('Piscicole Test');
        eclosion = await creerSecteur('Éclosion', piscicole);
        larvaire = await creerSecteur('Élevage larvaire', piscicole);
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('déplace des poissons : effectifs ajustés, espèce transmise au bassin vide, mouvement enregistré', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 5000, espece: 'Tilapia' });
        const arrivee = await creerBassin(larvaire, 'LAR-03', { effectif: 0 });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 1800, notes: 'Passage au stade larvaire' });

        expect(res.status).toBe(201);
        expect(res.body.avertissement).toBeNull();
        expect(res.body.source).toMatchObject({ code_lot: 'ECL-05', quantite: 3200, espece: 'Tilapia' });
        expect(res.body.destination).toMatchObject({ code_lot: 'LAR-03', quantite: 1800, espece: 'Tilapia' });
        expect(await bassin(depart)).toMatchObject({ quantite_initiale: 3200, espece: 'Tilapia' });
        expect(await bassin(arrivee)).toMatchObject({ quantite_initiale: 1800, espece: 'Tilapia' });
        const [m] = await mouvements();
        expect(m).toMatchObject({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 1800, espece: 'Tilapia', effectif_source_apres: 3200, effectif_destination_apres: 1800, notes: 'Passage au stade larvaire' });
    });

    test('vider un bassin : il devient sans espèce, les poissons arrivent avec la leur', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 1000, espece: 'Clarias' });
        const arrivee = await creerBassin(larvaire, 'LAR-03');

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 1000 });

        expect(res.status).toBe(201);
        expect(await bassin(depart)).toMatchObject({ quantite_initiale: 0, espece: null });
        expect(await bassin(arrivee)).toMatchObject({ quantite_initiale: 1000, espece: 'Clarias' });
    });

    test('bassin d’arrivée déjà occupé par la même espèce : effectifs additionnés, aucun avertissement', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 500, espece: 'Tilapia' });
        const arrivee = await creerBassin(larvaire, 'LAR-03', { effectif: 700, espece: 'tilapia' });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 200 });

        expect(res.status).toBe(201);
        expect(res.body.avertissement).toBeNull();
        expect(await bassin(arrivee)).toMatchObject({ quantite_initiale: 900, espece: 'tilapia' });
    });

    test('bassin d’arrivée occupé par une AUTRE espèce : il la garde, avertissement, mouvement quand même enregistré', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 500, espece: 'Clarias' });
        const arrivee = await creerBassin(larvaire, 'LAR-03', { effectif: 700, espece: 'Tilapia' });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 200 });

        expect(res.status).toBe(201);
        expect(res.body.avertissement).toMatch(/Tilapia/);
        expect(res.body.avertissement).toMatch(/Clarias/);
        expect(await bassin(arrivee)).toMatchObject({ quantite_initiale: 900, espece: 'Tilapia' });
        expect((await mouvements())[0].espece).toBe('Clarias');
    });

    test('impossible de déplacer plus de poissons que le bassin n’en contient : rien ne bouge', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100, espece: 'Tilapia' });
        const arrivee = await creerBassin(larvaire, 'LAR-03');

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 101 });

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/ne contient que 100/);
        expect(await bassin(depart)).toMatchObject({ quantite_initiale: 100 });
        expect(await bassin(arrivee)).toMatchObject({ quantite_initiale: 0 });
        expect(await mouvements()).toHaveLength(0);
    });

    test.each([[0], [-5], [1.5], ['abc'], [null], [undefined]])('un nombre de poissons invalide (%p) est refusé', async (quantite) => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });
        const arrivee = await creerBassin(larvaire, 'LAR-03');

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite });

        expect(res.status).toBe(400);
        expect(await mouvements()).toHaveLength(0);
    });

    test('un bassin ne peut pas se déplacer vers lui-même', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: depart, quantite: 10 });

        expect(res.status).toBe(400);
    });

    test('bassins manquants ou date invalide : 400', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });
        const arrivee = await creerBassin(larvaire, 'LAR-03');

        expect((await deplacer({ lot_source_id: depart, quantite: 10 })).status).toBe(400);
        expect((await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 10, date_mouvement: '26/09/2026' })).status).toBe(400);
    });

    test.each([['départ'], ['arrivée']])('un bassin clôturé ne peut pas servir de bassin de %s', async (role) => {
        const actif = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });
        const clos = await creerBassin(larvaire, 'LAR-03', { effectif: 100, statut: 'TERMINE' });
        const corps = role === 'départ' ? { lot_source_id: clos, lot_destination_id: actif } : { lot_source_id: actif, lot_destination_id: clos };

        const res = await deplacer({ ...corps, quantite: 10 });

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/clôturé/);
        expect(await mouvements()).toHaveLength(0);
    });

    test('un bassin d’une autre ferme est refusé (403), rien ne bouge', async () => {
        const autreFerme = await creerOrganisation(pool, 'Autre Ferme');
        const secteurAutre = await creerSecteur('Piscicole Autre', null, autreFerme);
        const etranger = await creerBassin(secteurAutre, 'ETR-01', { effectif: 50, tenant: autreFerme });
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: etranger, quantite: 10 });

        expect(res.status).toBe(403);
        expect(await bassin(depart)).toMatchObject({ quantite_initiale: 100 });
        expect(await bassin(etranger)).toMatchObject({ quantite_initiale: 50 });
    });

    test('un rôle sans droit sur la production (livreur) ne peut pas déplacer', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100 });
        const arrivee = await creerBassin(larvaire, 'LAR-03');
        const tokenLivreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId });

        const res = await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 10 }, tokenLivreur);

        expect(res.status).toBe(403);
    });

    test('le déplacement est journalisé dans l’audit', async () => {
        const depart = await creerBassin(eclosion, 'ECL-05', { effectif: 100, espece: 'Tilapia' });
        const arrivee = await creerBassin(larvaire, 'LAR-03');
        await deplacer({ lot_source_id: depart, lot_destination_id: arrivee, quantite: 10 });

        const audit = await pool.query(`SELECT * FROM audit_logs WHERE table_name = 'mouvements_bassins' AND action = 'CREATE'`);

        expect(audit.rows).toHaveLength(1);
    });

    describe('historique', () => {
        test('renvoie les déplacements, les plus récents d’abord, avec les codes de bassin et le type de bassin', async () => {
            const a = await creerBassin(eclosion, 'ECL-05', { effectif: 1000, espece: 'Tilapia' });
            const b = await creerBassin(larvaire, 'LAR-03');
            await deplacer({ lot_source_id: a, lot_destination_id: b, quantite: 300, date_mouvement: '2026-09-20' });
            await deplacer({ lot_source_id: a, lot_destination_id: b, quantite: 200, date_mouvement: '2026-09-26' });

            const res = await request(app).get('/api/production/mouvements').set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
            expect(res.body.map((m) => m.quantite)).toEqual([200, 300]);
            expect(res.body[0]).toMatchObject({ source_code: 'ECL-05', destination_code: 'LAR-03', source_secteur: 'Éclosion', destination_secteur: 'Élevage larvaire', espece: 'Tilapia' });
        });

        test('filtre par bassin', async () => {
            const a = await creerBassin(eclosion, 'ECL-05', { effectif: 1000, espece: 'Tilapia' });
            const b = await creerBassin(larvaire, 'LAR-03');
            const c = await creerBassin(larvaire, 'LAR-04');
            await deplacer({ lot_source_id: a, lot_destination_id: b, quantite: 300 });
            await deplacer({ lot_source_id: a, lot_destination_id: c, quantite: 100 });

            const res = await request(app).get(`/api/production/mouvements?lot_id=${c}`).set('Authorization', `Bearer ${token}`);

            expect(res.body).toHaveLength(1);
            expect(res.body[0].destination_code).toBe('LAR-04');
        });

        test('une ferme ne voit jamais les déplacements d’une autre', async () => {
            const a = await creerBassin(eclosion, 'ECL-05', { effectif: 1000 });
            const b = await creerBassin(larvaire, 'LAR-03');
            await deplacer({ lot_source_id: a, lot_destination_id: b, quantite: 300 });
            const autreFerme = await creerOrganisation(pool, 'Autre Ferme');
            const tokenAutre = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: autreFerme });

            const res = await request(app).get('/api/production/mouvements').set('Authorization', `Bearer ${tokenAutre}`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(0);
        });
    });
});

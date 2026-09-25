const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

// Retour de Clovis (2026-09-24) : les bassins gardent leur type, ce sont les poissons (l'espèce) qui changent de
// bassin. Le lot (= le bassin) porte donc l'espèce actuellement dedans.
describe('lots — espèce présente dans un bassin (Piscicole)', () => {
    let pool;
    let app;
    let tenantId;
    let token;
    let piscicole;
    let eclosion;

    const creerSecteur = async (nom, parentId = null) =>
        (await pool.query(`INSERT INTO secteurs (tenant_id, nom, parent_secteur_id) VALUES ($1, $2, $3) RETURNING id`, [tenantId, nom, parentId])).rows[0].id;

    const creerLot = (corps = {}) =>
        request(app)
            .post('/api/production/lots')
            .set('Authorization', `Bearer ${token}`)
            .send({ secteur_id: eclosion, code_lot: `ECL-${Math.floor(Math.random() * 100000)}`, quantite_initiale: 5000, date_demarrage: '2026-09-25', ...corps });

    const modifierLot = (id, corps) => request(app).put(`/api/production/lots/${id}`).set('Authorization', `Bearer ${token}`).send(corps);

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        piscicole = await creerSecteur('Piscicole Test');
        eclosion = await creerSecteur('Éclosion', piscicole);
        token = await creerUtilisateurEtToken(pool, { role: 'admin', tenant_id: tenantId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('un bassin est créé avec son espèce', async () => {
        const res = await creerLot({ espece: 'Tilapia' });

        expect(res.status).toBe(201);
        expect(res.body.espece).toBe('Tilapia');
    });

    test('l’espèce est facultative (bassin vide ou inconnue)', async () => {
        const res = await creerLot();

        expect(res.status).toBe(201);
        expect(res.body.espece).toBeNull();
    });

    test('l’espèce est nettoyée (espaces) et une chaîne vide devient « pas d’espèce »', async () => {
        expect((await creerLot({ espece: '  Clarias  ' })).body.espece).toBe('Clarias');
        expect((await creerLot({ espece: '   ' })).body.espece).toBeNull();
    });

    test('une espèce de plus de 100 caractères est refusée', async () => {
        const res = await creerLot({ espece: 'x'.repeat(101) });

        expect(res.status).toBe(400);
        expect(res.body.erreur).toMatch(/100/);
    });

    test('modifier l’espèce d’un bassin ne touche ni l’effectif ni la date', async () => {
        const lot = (await creerLot({ espece: 'Tilapia', quantite_initiale: 4200 })).body;

        const res = await modifierLot(lot.id, { espece: 'Clarias' });

        expect(res.status).toBe(200);
        expect(res.body.espece).toBe('Clarias');
        expect(Number(res.body.quantite_initiale)).toBe(4200);
        expect(String(res.body.date_demarrage)).toContain('2026-09-25');
    });

    test('corriger l’effectif sans parler d’espèce laisse l’espèce inchangée', async () => {
        const lot = (await creerLot({ espece: 'Tilapia' })).body;

        const res = await modifierLot(lot.id, { quantite_initiale: 3000 });

        expect(res.status).toBe(200);
        expect(res.body.espece).toBe('Tilapia');
        expect(Number(res.body.quantite_initiale)).toBe(3000);
    });

    test('une espèce vide efface l’espèce (bassin vidé)', async () => {
        const lot = (await creerLot({ espece: 'Tilapia' })).body;

        const res = await modifierLot(lot.id, { espece: '' });

        expect(res.status).toBe(200);
        expect(res.body.espece).toBeNull();
    });

    test('la liste des lots renvoie l’espèce et le nom du secteur parent (pour reconnaître un bassin piscicole)', async () => {
        await creerLot({ espece: 'Tilapia', code_lot: 'ECL-01' });

        const res = await request(app).get('/api/production/lots').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({ code_lot: 'ECL-01', espece: 'Tilapia', secteur_nom: 'Éclosion', secteur_parent_nom: 'Piscicole Test' });
    });

    test('une espèce trop longue est aussi refusée à la modification', async () => {
        const lot = (await creerLot()).body;
        expect((await modifierLot(lot.id, { espece: 'y'.repeat(101) })).status).toBe(400);
    });
});

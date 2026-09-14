const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerOrganisation, creerUtilisateurEtToken } = require('./helpers/testApp');

async function creerSecteurPourTenant(pool, tenantId, nom = 'Piscicole') {
    const res = await pool.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, $2) RETURNING id`, [tenantId, nom]);
    return res.rows[0].id;
}

async function creerLot(pool, tenantId, secteurId, overrides = {}) {
    const l = {
        code_lot: `LOT-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        quantite_initiale: 1,
        date_demarrage: '2026-09-14',
        statut: 'EN_COURS',
        ...overrides,
    };
    const res = await pool.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [tenantId, secteurId, l.code_lot, l.quantite_initiale, l.date_demarrage, l.statut]
    );
    return res.rows[0];
}

// PUT /production/lots/:id : corrige l'effectif/date d'un lot après sa création (ex. valeur
// provisoire posée à la configuration initiale d'une ferme, avant d'avoir les vrais chiffres du
// client) — ne touche jamais au statut ni à l'historique des relevés.
describe('production — PUT /lots/:id (correction effectif/date)', () => {
    let pool;
    let app;
    let tenantId;
    let secteurId;
    let tokenChefProd;
    let tokenAutreSecteur;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Fish Feed Test');
        secteurId = await creerSecteurPourTenant(pool, tenantId, 'Éclosion');
        const autreSecteurId = await creerSecteurPourTenant(pool, tenantId, 'Pregrossissement');
        tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId, secteur_id: secteurId });
        tokenAutreSecteur = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId, secteur_id: autreSecteurId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('corrige la quantité et la date de démarrage', async () => {
        const lot = await creerLot(pool, tenantId, secteurId);

        const res = await request(app)
            .put(`/api/production/lots/${lot.id}`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ quantite_initiale: 250, date_demarrage: '2026-08-01' });

        expect(res.status).toBe(200);
        expect(Number(res.body.quantite_initiale)).toBe(250);
        expect(String(res.body.date_demarrage)).toContain('2026-08-01');
    });

    test('ne modifie que le champ envoyé (COALESCE), laisse l\'autre inchangé', async () => {
        const lot = await creerLot(pool, tenantId, secteurId, { quantite_initiale: 20, date_demarrage: '2026-09-14' });

        const res = await request(app)
            .put(`/api/production/lots/${lot.id}`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ quantite_initiale: 42 });

        expect(res.status).toBe(200);
        expect(Number(res.body.quantite_initiale)).toBe(42);
        expect(String(res.body.date_demarrage)).toContain('2026-09-14');
    });

    test('rejette une quantité négative ou nulle', async () => {
        const lot = await creerLot(pool, tenantId, secteurId);
        const res = await request(app)
            .put(`/api/production/lots/${lot.id}`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ quantite_initiale: 0 });
        expect(res.status).toBe(400);
    });

    test('un chef de prod ne peut pas modifier un lot d\'un autre secteur', async () => {
        const lot = await creerLot(pool, tenantId, secteurId);
        const res = await request(app)
            .put(`/api/production/lots/${lot.id}`)
            .set('Authorization', `Bearer ${tokenAutreSecteur}`)
            .send({ quantite_initiale: 99 });
        expect(res.status).toBe(403);
    });

    // Même comportement que PUT /lots/:id/statut (route soeur) : verifierAccesLot renvoie false
    // pour un id inexistant (aucune ligne à comparer), donc 403 avant même d'atteindre l'UPDATE —
    // pas un vrai 404, mais le même choix délibéré déjà fait ailleurs dans ce fichier.
    test('un lot inexistant renvoie 403 (verifierAccesLot ne le distingue pas d\'un lot hors secteur)', async () => {
        const res = await request(app)
            .put('/api/production/lots/999999')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ quantite_initiale: 10 });
        expect(res.status).toBe(403);
    });

    test('un rôle non autorisé (livreur) reçoit 403', async () => {
        const lot = await creerLot(pool, tenantId, secteurId);
        const tokenLivreur = await creerUtilisateurEtToken(pool, { role: 'livreur', tenant_id: tenantId, secteur_id: secteurId });
        const res = await request(app)
            .put(`/api/production/lots/${lot.id}`)
            .set('Authorization', `Bearer ${tokenLivreur}`)
            .send({ quantite_initiale: 10 });
        expect(res.status).toBe(403);
    });
});

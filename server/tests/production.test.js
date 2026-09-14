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

// PUT /secteurs/:id/aliment-defaut + déduction automatique du stock d'intrants dans POST /sync
// (migration 23) — l'aliment consommé au relevé journalier n'est déduit que si le secteur du lot a
// un intrant "aliment par défaut" configuré ; sinon aucun effet (comportement historique inchangé).
describe('production — stock d\'intrants (aliment par défaut + déduction automatique)', () => {
    let pool;
    let app;
    let tenantId;
    let secteurId;
    let tokenChefProd;

    async function creerIntrant(overrides = {}) {
        const i = { nom: 'Aliment ponte', categorie: 'Aliment', unite: 'kg', secteur_id: secteurId, quantite_stock: 100, ...overrides };
        const res = await pool.query(
            `INSERT INTO intrants (tenant_id, secteur_id, nom, categorie, unite, quantite_stock) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [tenantId, i.secteur_id, i.nom, i.categorie, i.unite, i.quantite_stock]
        );
        return res.rows[0];
    }

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool, 'Ferme Avicole Test');
        secteurId = await creerSecteurPourTenant(pool, tenantId, 'Avicole');
        tokenChefProd = await creerUtilisateurEtToken(pool, { role: 'chef_prod', tenant_id: tenantId, secteur_id: secteurId });
        app = buildApp(pool, ['production']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('définit l\'aliment par défaut d\'un secteur', async () => {
        const intrant = await creerIntrant();
        const res = await request(app)
            .put(`/api/production/secteurs/${secteurId}/aliment-defaut`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ intrant_id: intrant.id });
        expect(res.status).toBe(200);
        expect(res.body.intrant_alimentation_id).toBe(intrant.id);
    });

    test('rejette un intrant_id invalide', async () => {
        const res = await request(app)
            .put(`/api/production/secteurs/${secteurId}/aliment-defaut`)
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ intrant_id: 999999 });
        expect(res.status).toBe(400);
    });

    test('un relevé avec aliment consommé déduit automatiquement le stock si un aliment par défaut est configuré', async () => {
        const intrant = await creerIntrant({ quantite_stock: 100 });
        await request(app).put(`/api/production/secteurs/${secteurId}/aliment-defaut`).set('Authorization', `Bearer ${tokenChefProd}`).send({ intrant_id: intrant.id });
        const lot = await creerLot(pool, tenantId, secteurId);

        const res = await request(app)
            .post('/api/production/sync')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ releves: [{ lot_id: lot.id, date_releve: '2026-09-14', conso_aliment_kg: 15 }] });
        expect(res.status).toBe(200);

        const apres = await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [intrant.id]);
        expect(Number(apres.rows[0].quantite_stock)).toBe(85);

        const mouvements = await pool.query(`SELECT * FROM mouvements_intrants WHERE intrant_id = $1`, [intrant.id]);
        expect(mouvements.rows).toHaveLength(1);
        expect(mouvements.rows[0].type).toBe('SORTIE');
        expect(mouvements.rows[0].motif).toBe('RELEVE_JOURNALIER');
        expect(mouvements.rows[0].lot_id).toBe(lot.id);
    });

    test('un relevé sans aliment par défaut configuré ne touche à aucun stock (comportement historique)', async () => {
        const intrant = await creerIntrant({ quantite_stock: 100 }); // créé mais jamais lié au secteur
        const lot = await creerLot(pool, tenantId, secteurId);

        const res = await request(app)
            .post('/api/production/sync')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ releves: [{ lot_id: lot.id, date_releve: '2026-09-14', conso_aliment_kg: 15 }] });
        expect(res.status).toBe(200);

        const apres = await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [intrant.id]);
        expect(Number(apres.rows[0].quantite_stock)).toBe(100);
    });

    test('la déduction automatique n\'est jamais bloquante même si elle rend le stock négatif', async () => {
        const intrant = await creerIntrant({ quantite_stock: 5 });
        await request(app).put(`/api/production/secteurs/${secteurId}/aliment-defaut`).set('Authorization', `Bearer ${tokenChefProd}`).send({ intrant_id: intrant.id });
        const lot = await creerLot(pool, tenantId, secteurId);

        const res = await request(app)
            .post('/api/production/sync')
            .set('Authorization', `Bearer ${tokenChefProd}`)
            .send({ releves: [{ lot_id: lot.id, date_releve: '2026-09-14', conso_aliment_kg: 15 }] });
        expect(res.status).toBe(200);

        const apres = await pool.query(`SELECT quantite_stock FROM intrants WHERE id = $1`, [intrant.id]);
        expect(Number(apres.rows[0].quantite_stock)).toBe(-10);
    });
});

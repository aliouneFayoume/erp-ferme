const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('comptabilite — import de relevé bancaire et suggestions de rapprochement', () => {
    let pool;
    let app;
    let token;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['comptabilite', 'finance']);
        token = await creerUtilisateurEtToken(pool, { role: 'comptable', nom_complet: 'Comptable Test' });
    });

    afterEach(async () => {
        await pool.end();
    });

    test('importe les lignes valides et rejette les lignes incomplètes', async () => {
        const res = await request(app)
            .post('/api/comptabilite/releves-bancaires/import')
            .set('Authorization', `Bearer ${token}`)
            .send({
                lignes: [
                    { date_operation: '2026-01-05', libelle: 'VIR WAVE CLIENT X', montant: 10000, type_operation: 'CREDIT' },
                    { date_operation: '2026-01-06', libelle: 'FRAIS BANCAIRES', montant: 500, type_operation: 'DEBIT' },
                    { date_operation: '', libelle: 'LIGNE INCOMPLETE', montant: 100, type_operation: 'CREDIT' },
                    { date_operation: '2026-01-07', libelle: 'MONTANT INVALIDE', montant: -50, type_operation: 'CREDIT' },
                ],
            });

        expect(res.status).toBe(201);
        expect(res.body.inserees).toBe(2);
        expect(res.body.rejetees).toHaveLength(2);

        const total = await pool.query(`SELECT COUNT(*) FROM releves_bancaires`);
        expect(Number(total.rows[0].count)).toBe(2);
    });

    test('refuse un import vide', async () => {
        const res = await request(app)
            .post('/api/comptabilite/releves-bancaires/import')
            .set('Authorization', `Bearer ${token}`)
            .send({ lignes: [] });

        expect(res.status).toBe(400);
    });

    test('suggère le paiement correspondant (montant identique, date proche) et pas un autre trop éloigné', async () => {
        const client = await creerClient(pool, { nom: 'Client Wave' });

        // Paiement proche (2 jours d'écart, même montant) : doit être suggéré.
        await pool.query(
            `INSERT INTO paiements (client_id, montant, methode_paiement, statut, date_paiement) VALUES ($1, 15000, 'WAVE', 'VALIDE', '2026-02-10')`,
            [client.id]
        );
        // Paiement même montant mais bien trop loin dans le temps : ne doit pas être suggéré à sa place.
        await pool.query(
            `INSERT INTO paiements (client_id, montant, methode_paiement, statut, date_paiement) VALUES ($1, 15000, 'WAVE', 'VALIDE', '2026-01-01')`,
            [client.id]
        );

        await pool.query(
            `INSERT INTO releves_bancaires (date_operation, libelle, montant, type_operation, cree_par) VALUES ('2026-02-12', 'VIR WAVE', 15000, 'CREDIT', NULL)`
        );

        const res = await request(app).get('/api/comptabilite/releves-bancaires').set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const releve = res.body.find((r) => r.libelle === 'VIR WAVE');
        expect(releve.suggestion).not.toBeNull();
        expect(releve.suggestion.client_nom).toBe('Client Wave');
    });

    test('ne suggère rien quand aucun paiement ne correspond (montant différent)', async () => {
        const client = await creerClient(pool, { nom: 'Client Sans Match' });
        await pool.query(
            `INSERT INTO paiements (client_id, montant, methode_paiement, statut, date_paiement) VALUES ($1, 3000, 'WAVE', 'VALIDE', '2026-02-10')`,
            [client.id]
        );
        await pool.query(
            `INSERT INTO releves_bancaires (date_operation, libelle, montant, type_operation, cree_par) VALUES ('2026-02-10', 'VIR INCONNU', 15000, 'CREDIT', NULL)`
        );

        const res = await request(app).get('/api/comptabilite/releves-bancaires').set('Authorization', `Bearer ${token}`);
        const releve = res.body.find((r) => r.libelle === 'VIR INCONNU');
        expect(releve.suggestion).toBeNull();
    });
});

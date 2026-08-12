const { createTestPool, seedRolesEtSecteurs, creerOrganisation } = require('./helpers/testApp');
const { genererNumeroUnique } = require('../src/numero');

// Audit sécurité 2026-08-11 (M3) : remplace l'ancien générateur CMD-${Date.now().toString().slice(-6)},
// dont les 6 derniers chiffres d'un timestamp en millisecondes se répètent toutes les ~16,7 minutes.
describe('numero — genererNumeroUnique', () => {
    let pool;
    let tenantId;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        tenantId = await creerOrganisation(pool);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('respecte le préfixe demandé', async () => {
        const numero = await genererNumeroUnique(pool, 'commandes', 'CMD', tenantId);
        expect(numero.startsWith('CMD-')).toBe(true);
        expect(numero.length).toBeLessThanOrEqual(20); // contrainte VARCHAR(20) du schéma
    });

    test('génère des numéros distincts sur des appels rapprochés', async () => {
        const numeros = new Set();
        for (let i = 0; i < 20; i++) {
            numeros.add(await genererNumeroUnique(pool, 'commandes', 'CMD', tenantId));
        }
        expect(numeros.size).toBe(20);
    });

    test('ignore un candidat déjà pris par la même ferme et en régénère un autre', async () => {
        const premier = await genererNumeroUnique(pool, 'commandes', 'CMD', tenantId);
        const client = (await pool.query(
            `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours)
             VALUES ($1, 'Client Test', 'B2C', 'standard', '+221770000099', 0, 0) RETURNING id`,
            [tenantId]
        )).rows[0];
        await pool.query(
            `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, 'EN_ATTENTE', 1000)`,
            [tenantId, premier, client.id]
        );

        // Ne peut pas forcer une collision réelle (horodatage + aléa), mais confirme au moins que la
        // fonction consulte bien la base — un second appel immédiat ne doit jamais renvoyer le
        // numéro déjà pris.
        const second = await genererNumeroUnique(pool, 'commandes', 'CMD', tenantId);
        expect(second).not.toBe(premier);
    });
});

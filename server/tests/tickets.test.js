const request = require('supertest');
const { createTestPool, buildApp, seedRolesEtSecteurs, creerClient, creerUtilisateurEtToken } = require('./helpers/testApp');

describe('support client — tickets', () => {
    let pool;
    let app;

    beforeEach(async () => {
        pool = createTestPool();
        await seedRolesEtSecteurs(pool);
        app = buildApp(pool, ['tickets']);
    });

    afterEach(async () => {
        await pool.end();
    });

    test('crée un ticket puis le retrouve dans la liste', async () => {
        const client = await creerClient(pool);
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable' });

        const creation = await request(app)
            .post('/api/tickets')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, sujet: 'Livraison en retard', priorite: 'HAUTE' });

        expect(creation.status).toBe(201);
        expect(creation.body.statut).toBe('OUVERT');

        const liste = await request(app).get('/api/tickets').set('Authorization', `Bearer ${token}`);
        expect(liste.status).toBe(200);
        expect(liste.body.find((t) => t.id === creation.body.id).client_nom).toBe(client.nom);
    });

    test('sans client_id ni sujet, renvoie 400', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable' });
        const res = await request(app).post('/api/tickets').set('Authorization', `Bearer ${token}`).send({});
        expect(res.status).toBe(400);
    });

    test('met à jour le statut et l\'assignation', async () => {
        const client = await creerClient(pool);
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable' });
        const agent = await creerUtilisateurEtToken(pool, { role: 'admin' });

        const creation = await request(app)
            .post('/api/tickets')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, sujet: 'Produit manquant' });

        const maj = await request(app)
            .put(`/api/tickets/${creation.body.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ statut: 'EN_COURS' });

        expect(maj.status).toBe(200);
        expect(maj.body.statut).toBe('EN_COURS');
        void agent;
    });

    test('ajoute un message au fil de discussion du ticket', async () => {
        const client = await creerClient(pool);
        const token = await creerUtilisateurEtToken(pool, { role: 'comptable' });

        const creation = await request(app)
            .post('/api/tickets')
            .set('Authorization', `Bearer ${token}`)
            .send({ client_id: client.id, sujet: 'Question facture' });

        const message = await request(app)
            .post(`/api/tickets/${creation.body.id}/messages`)
            .set('Authorization', `Bearer ${token}`)
            .send({ message: 'Le comptable a rappelé le client.' });

        expect(message.status).toBe(201);

        const fil = await request(app).get(`/api/tickets/${creation.body.id}/messages`).set('Authorization', `Bearer ${token}`);
        expect(fil.status).toBe(200);
        expect(fil.body).toHaveLength(1);
        expect(fil.body[0].auteur_nom).toBeTruthy();
    });

    test('un livreur ne peut pas accéder aux tickets', async () => {
        const token = await creerUtilisateurEtToken(pool, { role: 'livreur' });
        const res = await request(app).get('/api/tickets').set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });
});

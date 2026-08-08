const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signClientToken, requireClientAuth } = require('../auth');
const { genererFacturePDF } = require('../facturePdf');

// Un PIN à 6 chiffres a beaucoup moins d'entropie qu'un mot de passe : limite plus stricte que le
// login staff (10/15min) pour compenser, en plus de la vérification téléphone+PIN combinée.
const limiteurLoginPortail = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives de connexion. Réessayez plus tard.' },
});

module.exports = function portailRoutes(pool) {
    const router = express.Router();
    const clientAuth = requireClientAuth(pool);

    router.post('/login', limiteurLoginPortail, async (req, res) => {
        const { telephone, pin } = req.body;
        if (!telephone || !pin) {
            return res.status(400).json({ erreur: 'Téléphone et code sont obligatoires.' });
        }
        // telephone reste unique globalement (pas par organisation) — même choix pragmatique que
        // utilisateurs.email (voir schema.sql) : le login ne connaît pas l'organisation au moment de
        // la requête, donc scoper par tenant nécessiterait de la résoudre autrement au préalable
        // (sous-domaine par ferme, non construit). Si deux fermes distinctes doivent un jour pouvoir
        // avoir chacune un client avec le même numéro, cette contrainte devra être revue en même
        // temps qu'une résolution de tenant côté login.
        // Lecture pré-tenant (le tenant n'est pas encore connu avant cette ligne) : policy RLS dédiée
        // sur `clients` qui autorise ce cas précis, voir rls-policies.sql.
        const result = await pool.query(
            `SELECT id, nom, telephone, type_client, pin_hash, pin_version FROM clients WHERE telephone = $1 AND deleted_at IS NULL`,
            [telephone]
        );
        const client = result.rows[0];
        if (!client || !client.pin_hash) {
            return res.status(401).json({ erreur: 'Identifiants incorrects.' });
        }
        const valide = await bcrypt.compare(pin, client.pin_hash);
        if (!valide) {
            return res.status(401).json({ erreur: 'Identifiants incorrects.' });
        }
        const token = signClientToken(client);
        res.json({ token, client: { id: client.id, nom: client.nom, telephone: client.telephone, type_client: client.type_client } });
    });

    router.get('/moi', clientAuth, async (req, res) => {
        const result = await req.db.query(
            `SELECT id, nom, telephone, type_client, categorie_tarifaire, adresse, limite_credit, solde_encours
             FROM clients WHERE id = $1`,
            [req.client.id]
        );
        res.json(result.rows[0]);
    });

    router.get('/commandes', clientAuth, async (req, res) => {
        const commandes = await req.db.query(
            `SELECT * FROM commandes WHERE client_id = $1 AND deleted_at IS NULL ORDER BY cree_le DESC LIMIT 100`,
            [req.client.id]
        );
        const commandesAvecLignes = [];
        for (const c of commandes.rows) {
            const lignes = await req.db.query(
                `SELECT lc.*, p.nom as produit_nom FROM lignes_commande lc JOIN produits p ON lc.produit_id = p.id WHERE lc.commande_id = $1`,
                [c.id]
            );
            commandesAvecLignes.push({ ...c, lignes: lignes.rows });
        }
        res.json(commandesAvecLignes);
    });

    router.get('/factures', clientAuth, async (req, res) => {
        const result = await req.db.query(
            `SELECT f.*, c.numero_commande FROM factures f
             JOIN commandes c ON f.commande_id = c.id
             WHERE c.client_id = $1 ORDER BY f.date_echeance DESC LIMIT 100`,
            [req.client.id]
        );
        res.json(result.rows);
    });

    router.get('/factures/:id/pdf', clientAuth, async (req, res) => {
        const factureRes = await req.db.query(
            `SELECT f.*, c.numero_commande, c.montant_total, c.client_id
             FROM factures f JOIN commandes c ON f.commande_id = c.id
             WHERE f.id = $1`,
            [req.params.id]
        );
        const facture = factureRes.rows[0];
        if (!facture || facture.client_id !== req.client.id) {
            return res.status(404).json({ erreur: 'Facture introuvable.' });
        }

        const clientRes = await req.db.query(`SELECT * FROM clients WHERE id = $1`, [facture.client_id]);
        const lignesRes = await req.db.query(
            `SELECT lc.*, p.nom as produit_nom FROM lignes_commande lc JOIN produits p ON lc.produit_id = p.id WHERE lc.commande_id = $1`,
            [facture.commande_id]
        );

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="facture-${facture.numero_commande}.pdf"`);
        genererFacturePDF(res, {
            facture,
            commande: { numero_commande: facture.numero_commande, montant_total: facture.montant_total },
            client: clientRes.rows[0],
            lignes: lignesRes.rows,
        });
    });

    router.get('/livraisons', clientAuth, async (req, res) => {
        const result = await req.db.query(
            `SELECT l.*, c.numero_commande FROM livraisons l
             JOIN commandes c ON l.commande_id = c.id
             WHERE c.client_id = $1 ORDER BY l.date_prevue DESC LIMIT 100`,
            [req.client.id]
        );
        res.json(result.rows);
    });

    router.get('/tickets', clientAuth, async (req, res) => {
        const result = await req.db.query(
            `SELECT * FROM tickets WHERE client_id = $1 AND deleted_at IS NULL ORDER BY cree_le DESC LIMIT 100`,
            [req.client.id]
        );
        res.json(result.rows);
    });

    router.post('/tickets', clientAuth, async (req, res) => {
        const { sujet, description } = req.body;
        if (!sujet || !sujet.trim()) {
            return res.status(400).json({ erreur: 'Le sujet est obligatoire.' });
        }
        const result = await req.db.query(
            `INSERT INTO tickets (tenant_id, client_id, sujet, description) VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.client.tenant_id, req.client.id, sujet.trim(), description || null]
        );
        res.status(201).json(result.rows[0]);
    });

    router.get('/tickets/:id/messages', clientAuth, async (req, res) => {
        const ticketRes = await req.db.query(`SELECT client_id FROM tickets WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
        if (ticketRes.rows.length === 0 || ticketRes.rows[0].client_id !== req.client.id) {
            return res.status(404).json({ erreur: 'Ticket introuvable.' });
        }
        const result = await req.db.query(
            `SELECT m.*, COALESCE(u.nom_complet, cl.nom) as auteur_nom,
                    CASE WHEN m.auteur_client_id IS NOT NULL THEN 'client' ELSE 'staff' END as auteur_type
             FROM ticket_messages m
             LEFT JOIN utilisateurs u ON m.utilisateur_id = u.id
             LEFT JOIN clients cl ON m.auteur_client_id = cl.id
             WHERE m.ticket_id = $1 ORDER BY m.cree_le ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    router.post('/tickets/:id/messages', clientAuth, async (req, res) => {
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ erreur: 'Message vide.' });
        const ticketRes = await req.db.query(`SELECT client_id FROM tickets WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
        if (ticketRes.rows.length === 0 || ticketRes.rows[0].client_id !== req.client.id) {
            return res.status(404).json({ erreur: 'Ticket introuvable.' });
        }
        const result = await req.db.query(
            `INSERT INTO ticket_messages (ticket_id, auteur_client_id, message) VALUES ($1, $2, $3) RETURNING *`,
            [req.params.id, req.client.id, message.trim()]
        );
        await req.db.query(`UPDATE tickets SET mis_a_jour_le = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        res.status(201).json(result.rows[0]);
    });

    return router;
};

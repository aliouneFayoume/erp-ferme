const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signClientToken, requireClientAuth, queryPreTenant, queryAvecTenant } = require('../auth');
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

// Verrouillage PAR COMPTE (numéro de téléphone), en plus de la limite par IP ci-dessus — audit
// sécurité 2026-08-11 (E1) : la limite par IP seule est contournable en distribuant les tentatives
// sur plusieurs IP (ex: un script tournant dans le navigateur de visiteurs tiers, désormais bloqué
// par la restriction CORS de index.js, mais ce verrouillage reste utile en défense en profondeur —
// y compris contre un botnet qui n'a pas besoin de lire la réponse pour être gênant).
const MAX_TENTATIVES_PIN = 5;
const DUREE_BLOCAGE_MINUTES = 15;

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
        // la requête. Les sous-domaines par ferme (routes/public.js) existent maintenant, mais
        // UNIQUEMENT pour l'image de marque avant connexion — décision explicite de ne pas les
        // utiliser pour résoudre le tenant ici, donc cette contrainte globale reste inchangée pour
        // l'instant. Si deux fermes distinctes doivent un jour pouvoir avoir chacune un client avec
        // le même numéro, ce serait le moment de revisiter les deux ensemble.
        // Lecture pré-tenant (le tenant n'est pas encore connu avant cette ligne) : policy RLS dédiée
        // sur `clients` qui autorise ce cas précis, voir rls-policies.sql.
        const result = await queryPreTenant(
            pool,
            `SELECT c.id, c.tenant_id, c.nom, c.telephone, c.type_client, c.pin_hash, c.pin_version,
                    c.pin_tentatives_echouees, c.pin_bloque_jusqu, o.nom as organisation_nom
             FROM clients c LEFT JOIN organisations o ON c.tenant_id = o.id
             WHERE c.telephone = $1 AND c.deleted_at IS NULL`,
            [telephone]
        );
        const client = result.rows[0];
        if (!client || !client.pin_hash) {
            return res.status(401).json({ erreur: 'Identifiants incorrects.' });
        }

        // Compte verrouillé : on refuse avant même de comparer le PIN (utile même si le PIN fourni
        // est le bon — sinon un verrouillage n'empêche rien, il retarde juste de la durée d'un essai).
        if (client.pin_bloque_jusqu && new Date(client.pin_bloque_jusqu) > new Date()) {
            return res.status(429).json({ erreur: 'Trop de tentatives échouées. Réessayez dans quelques minutes.' });
        }

        const valide = await bcrypt.compare(pin, client.pin_hash);
        if (!valide) {
            const tentatives = (client.pin_tentatives_echouees || 0) + 1;
            const bloque = tentatives >= MAX_TENTATIVES_PIN;
            const bloqueJusqu = bloque ? new Date(Date.now() + DUREE_BLOCAGE_MINUTES * 60 * 1000) : null;
            await queryAvecTenant(
                pool,
                client.tenant_id,
                // COALESCE : si on ne vient pas de déclencher un blocage, on laisse pin_bloque_jusqu
                // tel quel (déjà NULL ou déjà expiré à ce stade — la vérification en tête de route
                // a rejeté toute tentative sur un compte encore verrouillé).
                `UPDATE clients SET pin_tentatives_echouees = $1, pin_bloque_jusqu = COALESCE($2, pin_bloque_jusqu) WHERE id = $3`,
                [bloque ? 0 : tentatives, bloqueJusqu, client.id]
            ).catch((err) => console.error('Échec de la mise à jour du compteur de tentatives PIN:', err));
            if (bloque) {
                return res.status(429).json({ erreur: 'Trop de tentatives échouées. Réessayez dans quelques minutes.' });
            }
            return res.status(401).json({ erreur: 'Identifiants incorrects.' });
        }

        // PIN correct : on réinitialise le compteur (sans bloquer la connexion si cette écriture
        // échoue — un compteur non remis à zéro n'est jamais qu'un verrouillage légèrement anticipé
        // au prochain échec, pas une faille).
        if (client.pin_tentatives_echouees > 0 || client.pin_bloque_jusqu) {
            await queryAvecTenant(
                pool,
                client.tenant_id,
                `UPDATE clients SET pin_tentatives_echouees = 0, pin_bloque_jusqu = NULL WHERE id = $1`,
                [client.id]
            ).catch((err) => console.error('Échec de la réinitialisation du compteur de tentatives PIN:', err));
        }

        const token = signClientToken(client);
        res.json({
            token,
            client: { id: client.id, nom: client.nom, telephone: client.telephone, type_client: client.type_client, organisation_nom: client.organisation_nom },
        });
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
        const orgRes = await req.db.query(`SELECT nom, adresse, telephone FROM organisations WHERE id = $1`, [req.client.tenant_id]);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="facture-${facture.numero_commande}.pdf"`);
        genererFacturePDF(res, {
            facture,
            commande: { numero_commande: facture.numero_commande, montant_total: facture.montant_total },
            client: clientRes.rows[0],
            lignes: lignesRes.rows,
            organisation: orgRes.rows[0],
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

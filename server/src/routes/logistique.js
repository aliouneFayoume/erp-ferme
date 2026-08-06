const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');
const { FARM_DEPOT, optimiserTournee, itineraireReel } = require('../routing');

module.exports = function logistiqueRoutes(pool) {
    const router = express.Router();

    /**
     * Feuille de route du livreur connecté (TMS), basée sur les coordonnées GPS du client (pas
     * d'adresse textuelle) et optimisée par ordre de passage depuis le dépôt de la ferme.
     */
    router.get('/tournees', requireAuth, checkRole(['livreur']), async (req, res) => {
        try {
            const livreurId = req.user.role === 'livreur' ? req.user.id : req.query.livreur_id;
            const aujourdhui = new Date().toISOString().slice(0, 10);
            const query = `
                SELECT l.id as livraison_id, l.statut, l.notes_livreur, l.preuve_livraison,
                       c.id as commande_id, c.numero_commande, c.montant_total,
                       cl.id as client_id, cl.nom as client_nom, cl.type_client, cl.gps_lat, cl.gps_lng, cl.adresse
                FROM livraisons l
                JOIN commandes c ON l.commande_id = c.id
                JOIN clients cl ON c.client_id = cl.id
                WHERE (l.livreur_id = $1 OR $1 IS NULL)
                AND l.date_prevue = $2
                AND l.statut IN ('A_FAIRE', 'EN_COURS')
                ORDER BY l.statut DESC, l.id ASC
            `;
            const result = await pool.query(query, [livreurId || null, aujourdhui]);
            const tournee = await optimiserTournee(result.rows);

            // Tracé routier réel suivant l'ordre optimisé (dépôt puis arrêts) — distinct de la
            // matrice de distances utilisée pour l'optimisation elle-même. Best-effort : une
            // tournée doit toujours s'afficher même si ce tracé échoue.
            let trace = null;
            try {
                trace = await itineraireReel([
                    FARM_DEPOT,
                    ...tournee.map((t) => ({ lat: Number(t.gps_lat), lng: Number(t.gps_lng) })),
                ]);
            } catch (err) {
                console.error("OpenRouteService indisponible pour le tracé, repli sur la ligne droite :", err.message);
            }

            res.json({ depot: FARM_DEPOT, arrets: tournee, trace });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des tournées.' });
        }
    });

    // Historique des livraisons (toutes statuts confondus) : sert notamment à consulter la preuve de livraison.
    router.get('/livraisons', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await pool.query(
            `SELECT l.*, c.numero_commande, cl.nom as client_nom, u.nom_complet as livreur_nom
             FROM livraisons l
             JOIN commandes c ON l.commande_id = c.id
             JOIN clients cl ON c.client_id = cl.id
             LEFT JOIN utilisateurs u ON l.livreur_id = u.id
             ORDER BY l.mise_a_jour_le DESC LIMIT 100`
        );
        res.json(result.rows);
    });

    router.post('/livraisons', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { commande_id, livreur_id, date_prevue } = req.body;
        const result = await pool.query(
            `INSERT INTO livraisons (commande_id, livreur_id, date_prevue, statut) VALUES ($1, $2, $3, 'A_FAIRE') RETURNING *`,
            [commande_id, livreur_id, date_prevue]
        );
        await pool.query(`UPDATE commandes SET statut = 'EN_LIVRAISON' WHERE id = $1`, [commande_id]);
        await logAudit(pool, { table: 'livraisons', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: { commande_id, livreur_id } });
        res.status(201).json(result.rows[0]);
    });

    // Mise à jour terrain : statut, preuve de livraison, et éventuel encaissement espèces (caisse chauffeur virtuelle).
    const METHODES_PAIEMENT_VALIDES = ['ESPECES', 'WAVE', 'ORANGE_MONEY', 'VIREMENT'];

    router.put('/livraisons/:id/statut', requireAuth, checkRole(['livreur']), async (req, res) => {
        const { statut, notes_livreur, preuve_livraison, montant_encaisse } = req.body;
        // Le livreur encaisse aussi bien en espèces qu'en Wave/Orange Money reçu sur place au
        // moment de la livraison — la caisse chauffeur virtuelle doit refléter le mode réel.
        const methode_paiement = req.body.methode_paiement || 'ESPECES';
        if (montant_encaisse && !METHODES_PAIEMENT_VALIDES.includes(methode_paiement)) {
            return res.status(400).json({ erreur: 'Mode de paiement invalide.' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const livraisonRes = await client.query(`SELECT * FROM livraisons WHERE id = $1 FOR UPDATE`, [req.params.id]);
            if (livraisonRes.rows.length === 0) throw { statut: 404, message: 'Livraison introuvable.' };
            const livraison = livraisonRes.rows[0];

            // Un livreur ne peut modifier que ses propres livraisons (l'admin garde un accès total via checkRole).
            if (req.user.role === 'livreur' && livraison.livreur_id !== req.user.id) {
                throw { statut: 403, message: "Cette livraison n'est pas assignée à votre compte." };
            }

            const updated = await client.query(
                `UPDATE livraisons SET statut = $1, notes_livreur = COALESCE($2, notes_livreur),
                        preuve_livraison = COALESCE($3, preuve_livraison), mise_a_jour_le = CURRENT_TIMESTAMP
                 WHERE id = $4 RETURNING *`,
                [statut, notes_livreur, preuve_livraison, req.params.id]
            );

            if (statut === 'TERMINEE') {
                const commandeRes = await client.query(`SELECT * FROM commandes WHERE id = $1`, [livraison.commande_id]);
                const commande = commandeRes.rows[0];
                await client.query(`UPDATE commandes SET statut = 'LIVREE' WHERE id = $1`, [commande.id]);

                // Libère le pool réservé : le stock est désormais consommé (livré).
                const lignes = await client.query(`SELECT * FROM lignes_commande WHERE commande_id = $1`, [commande.id]);
                const clientRes = await client.query(`SELECT * FROM clients WHERE id = $1`, [commande.client_id]);
                const colonnePool = clientRes.rows[0].type_client === 'B2B' ? 'quantite_reservee_b2b' : 'quantite_reservee_b2c';
                // Note : pg-mem (simulation) inverse le signe de "colonne - $param" ; on ajoute une valeur
                // négative pour rester compatible avec pg-mem ET PostgreSQL réel.
                for (const ligne of lignes.rows) {
                    await client.query(
                        `UPDATE stocks SET ${colonnePool} = GREATEST(${colonnePool} + $1, 0) WHERE produit_id = $2`,
                        [-ligne.quantite, ligne.produit_id]
                    );
                }

                if (montant_encaisse && Number(montant_encaisse) > 0) {
                    await client.query(
                        `INSERT INTO paiements (commande_id, client_id, montant, methode_paiement, statut, livreur_id)
                         VALUES ($1, $2, $3, $4, 'VALIDE', $5)`,
                        [commande.id, commande.client_id, montant_encaisse, methode_paiement, req.user.id]
                    );
                    const moinsEncaissement = -Number(montant_encaisse);
                    await client.query(
                        `UPDATE factures SET montant_restant = GREATEST(montant_restant + $1, 0),
                                statut = CASE WHEN montant_restant + $1 <= 0 THEN 'PAYEE' ELSE 'PAYEE_PARTIEL' END
                         WHERE commande_id = $2`,
                        [moinsEncaissement, commande.id]
                    );
                    if (clientRes.rows[0].type_client === 'B2B') {
                        await client.query(`UPDATE clients SET solde_encours = GREATEST(solde_encours + $1, 0) WHERE id = $2`, [
                            moinsEncaissement,
                            commande.client_id,
                        ]);
                    }

                    // La caisse chauffeur virtuelle ne suit que les espèces réellement en poche du
                    // livreur (à déposer/justifier) — un encaissement Wave/Orange Money va
                    // directement sur le compte de la ferme, pas dans la caisse physique.
                    if (methode_paiement === 'ESPECES') {
                        const aujourdhui = new Date().toISOString().slice(0, 10);
                        await client.query(
                            `UPDATE caisses_chauffeur SET montant_theorique = montant_theorique + $1
                             WHERE livreur_id = $2 AND date_caisse = $3 AND statut = 'OUVERTE'`,
                            [montant_encaisse, req.user.id, aujourdhui]
                        );
                    }
                }
            }

            await client.query('COMMIT');
            await logAudit(pool, { table: 'livraisons', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { statut } });
            res.json(updated.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour de la livraison.' });
        } finally {
            client.release();
        }
    });

    // Caisse Chauffeur Virtuelle : ouverture journalière par le livreur.
    router.post('/caisse/ouvrir', requireAuth, checkRole(['livreur']), async (req, res) => {
        try {
            const aujourdhui = new Date().toISOString().slice(0, 10);
            const result = await pool.query(
                `INSERT INTO caisses_chauffeur (livreur_id, date_caisse, statut) VALUES ($1, $2, 'OUVERTE')
                 ON CONFLICT (livreur_id, date_caisse) DO UPDATE SET statut = caisses_chauffeur.statut RETURNING *`,
                [req.user.id, aujourdhui]
            );
            await logAudit(pool, { table: 'caisses_chauffeur', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'ouverture de la caisse." });
        }
    });

    router.get('/caisse', requireAuth, checkRole(['comptable', 'livreur']), async (req, res) => {
        const params = [];
        let where = '1=1';
        if (req.user.role === 'livreur') {
            params.push(req.user.id);
            where = `cc.livreur_id = $${params.length}`;
        }
        const result = await pool.query(
            `SELECT cc.*, u.nom_complet as livreur_nom FROM caisses_chauffeur cc
             JOIN utilisateurs u ON cc.livreur_id = u.id
             WHERE ${where} ORDER BY cc.date_caisse DESC LIMIT 60`,
            params
        );
        res.json(result.rows);
    });

    // Clôture de caisse : rapprochement entre encaissements théoriques (app) et dépôt réel (comptable).
    router.put('/caisse/:id/cloturer', requireAuth, checkRole(['comptable']), async (req, res) => {
        const { montant_depose, notes } = req.body;
        try {
            const caisseRes = await pool.query(`SELECT * FROM caisses_chauffeur WHERE id = $1`, [req.params.id]);
            if (caisseRes.rows.length === 0) return res.status(404).json({ erreur: 'Caisse introuvable.' });
            const theorique = Number(caisseRes.rows[0].montant_theorique);
            const ecart = Number(montant_depose) - theorique;

            const result = await pool.query(
                `UPDATE caisses_chauffeur SET statut = 'CLOTUREE', montant_depose = $1, ecart = $2,
                        valide_par = $3, notes = $4, cloturee_le = CURRENT_TIMESTAMP
                 WHERE id = $5 RETURNING *`,
                [montant_depose, ecart, req.user.id, notes || null, req.params.id]
            );
            await logAudit(pool, { table: 'caisses_chauffeur', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { montant_depose, ecart } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la clôture de caisse.' });
        }
    });

    return router;
};

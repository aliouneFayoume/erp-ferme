const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

/**
 * Multitarification à 3 niveaux (cahier des charges §3.2) : standard (B2C), restaurant (B2B),
 * grossiste (B2B, tarif préférentiel gros volumes). Le grossiste retombe sur le tarif B2B standard
 * si aucun tarif grossiste n'a été défini pour le produit.
 */
function resolvePrixUnitaire(produit, acheteur) {
    if (acheteur.categorie_tarifaire === 'grossiste' && produit.prix_unitaire_grossiste != null) {
        return Number(produit.prix_unitaire_grossiste);
    }
    return Number(acheteur.type_client === 'B2B' ? produit.prix_unitaire_b2b : produit.prix_unitaire_b2c);
}

module.exports = function commandesRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth, async (req, res) => {
        const result = await pool.query(
            `SELECT c.*, cl.nom as client_nom, cl.type_client
             FROM commandes c JOIN clients cl ON c.client_id = cl.id
             WHERE c.deleted_at IS NULL ORDER BY c.cree_le DESC LIMIT 200`
        );
        res.json(result.rows);
    });

    router.get('/:id', requireAuth, async (req, res) => {
        const commande = await pool.query(
            `SELECT c.*, cl.nom as client_nom, cl.type_client FROM commandes c JOIN clients cl ON c.client_id = cl.id WHERE c.id = $1`,
            [req.params.id]
        );
        if (commande.rows.length === 0) return res.status(404).json({ erreur: 'Commande introuvable.' });
        const lignes = await pool.query(
            `SELECT lc.*, p.nom as produit_nom FROM lignes_commande lc JOIN produits p ON lc.produit_id = p.id WHERE lc.commande_id = $1`,
            [req.params.id]
        );
        res.json({ ...commande.rows[0], lignes: lignes.rows });
    });

    /**
     * Création d'une commande B2B ou B2C.
     * - Applique la grille tarifaire correspondant au type de client.
     * - Réserve le stock dans le pool dédié (B2B ou B2C) pour éviter les surventes croisées.
     * - Pour le B2B : bloque automatiquement la commande si l'encours dépasse la limite de crédit.
     */
    router.post('/', requireAuth, checkRole(['admin', 'comptable']), async (req, res) => {
        const { client_id, lignes } = req.body;
        if (!client_id || !Array.isArray(lignes) || lignes.length === 0) {
            return res.status(400).json({ erreur: 'Client et au moins une ligne de commande sont requis.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const clientRes = await client.query(`SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [client_id]);
            if (clientRes.rows.length === 0) throw { statut: 404, message: 'Client introuvable.' };
            const acheteur = clientRes.rows[0];
            const estB2B = acheteur.type_client === 'B2B';

            let montantTotal = 0;
            const lignesPreparees = [];

            for (const ligne of lignes) {
                const produitRes = await client.query(
                    `SELECT p.*, s.quantite_disponible FROM produits p JOIN stocks s ON s.produit_id = p.id WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE`,
                    [ligne.produit_id]
                );
                if (produitRes.rows.length === 0) throw { statut: 404, message: `Produit ${ligne.produit_id} introuvable.` };
                const produit = produitRes.rows[0];

                if (Number(produit.quantite_disponible) < Number(ligne.quantite)) {
                    throw { statut: 409, message: `Stock insuffisant pour ${produit.nom} (disponible: ${produit.quantite_disponible}).` };
                }

                const prixUnitaire = resolvePrixUnitaire(produit, acheteur);
                const sousTotal = prixUnitaire * Number(ligne.quantite);
                montantTotal += sousTotal;

                lignesPreparees.push({ produit_id: produit.id, quantite: Number(ligne.quantite), prixUnitaire, sousTotal });

                const colonnePool = estB2B ? 'quantite_reservee_b2b' : 'quantite_reservee_b2c';
                // Note : pg-mem (simulation) calcule mal "colonne - $param" (inversion de signe) ; on ajoute
                // donc une valeur négative pour rester compatible avec pg-mem ET PostgreSQL réel.
                await client.query(
                    `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, ${colonnePool} = ${colonnePool} + $2, derniere_mise_a_jour = CURRENT_TIMESTAMP
                     WHERE produit_id = $3`,
                    [-ligne.quantite, ligne.quantite, produit.id]
                );
            }

            // Blocage automatique en cas de dépassement de l'encours autorisé (B2B à 30 jours)
            if (estB2B) {
                const nouvelEncours = Number(acheteur.solde_encours) + montantTotal;
                if (nouvelEncours > Number(acheteur.limite_credit)) {
                    throw {
                        statut: 403,
                        message: `Encours dépassé : ${nouvelEncours.toFixed(2)} FCFA > limite de crédit ${Number(acheteur.limite_credit).toFixed(2)} FCFA. Commande bloquée.`,
                    };
                }
            }

            const numero = `CMD-${Date.now().toString().slice(-6)}`;
            const commandeRes = await client.query(
                `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ($1, $2, 'EN_ATTENTE', $3) RETURNING *`,
                [numero, client_id, montantTotal]
            );
            const commande = commandeRes.rows[0];

            for (const l of lignesPreparees) {
                await client.query(
                    `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, $3, $4, $5)`,
                    [commande.id, l.produit_id, l.quantite, l.prixUnitaire, l.sousTotal]
                );
            }

            const dateEcheance = new Date();
            dateEcheance.setDate(dateEcheance.getDate() + (estB2B ? 30 : 0));
            await client.query(
                `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', $3)`,
                [commande.id, dateEcheance.toISOString().slice(0, 10), montantTotal]
            );

            if (estB2B) {
                await client.query(`UPDATE clients SET solde_encours = solde_encours + $1 WHERE id = $2`, [montantTotal, client_id]);
            }

            await client.query('COMMIT');
            await logAudit(pool, { table: 'commandes', rowId: commande.id, action: 'CREATE', userId: req.user.id, details: { montantTotal, client_id } });
            res.status(201).json({ ...commande, lignes: lignesPreparees });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) {
                res.status(err.statut).json({ erreur: err.message });
            } else {
                console.error(err);
                res.status(500).json({ erreur: 'Erreur lors de la création de la commande.' });
            }
        } finally {
            client.release();
        }
    });

    router.put('/:id/statut', requireAuth, checkRole(['admin', 'comptable', 'livreur']), async (req, res) => {
        const { statut } = req.body;
        const statutsValides = ['EN_ATTENTE', 'PREPAREE', 'EN_LIVRAISON', 'LIVREE', 'ANNULEE'];
        if (!statutsValides.includes(statut)) {
            return res.status(400).json({ erreur: 'Statut invalide.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const commandeRes = await client.query(
                `SELECT * FROM commandes WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
                [req.params.id]
            );
            if (commandeRes.rows.length === 0) throw { statut: 404, message: 'Commande introuvable.' };
            const commande = commandeRes.rows[0];

            // Annulation : libère le stock réservé et l'encours B2B consommés à la création, pour ne
            // pas bloquer indéfiniment de la capacité de pool ou du crédit sur une commande abandonnée.
            if (statut === 'ANNULEE' && commande.statut !== 'ANNULEE') {
                if (commande.statut === 'LIVREE') {
                    throw { statut: 400, message: 'Impossible d\'annuler une commande déjà livrée.' };
                }

                const clientRes = await client.query(`SELECT * FROM clients WHERE id = $1 FOR UPDATE`, [commande.client_id]);
                const acheteur = clientRes.rows[0];
                const colonnePool = acheteur.type_client === 'B2B' ? 'quantite_reservee_b2b' : 'quantite_reservee_b2c';

                const lignes = await client.query(`SELECT * FROM lignes_commande WHERE commande_id = $1`, [commande.id]);
                for (const ligne of lignes.rows) {
                    await client.query(
                        `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, ${colonnePool} = GREATEST(${colonnePool} + $2, 0)
                         WHERE produit_id = $3`,
                        [ligne.quantite, -ligne.quantite, ligne.produit_id]
                    );
                }

                if (acheteur.type_client === 'B2B') {
                    await client.query(`UPDATE clients SET solde_encours = GREATEST(solde_encours + $1, 0) WHERE id = $2`, [
                        -Number(commande.montant_total),
                        commande.client_id,
                    ]);
                }
            }

            const result = await client.query(
                `UPDATE commandes SET statut = $1 WHERE id = $2 RETURNING *`,
                [statut, req.params.id]
            );

            await client.query('COMMIT');
            await logAudit(pool, { table: 'commandes', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { statut } });
            res.json(result.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du statut.' });
        } finally {
            client.release();
        }
    });

    return router;
};

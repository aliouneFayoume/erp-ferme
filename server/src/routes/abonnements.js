const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function abonnementsRoutes(pool) {
    const router = express.Router();

    router.get('/', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const result = await req.db.query(
            `SELECT a.*, c.nom as client_nom, c.telephone, p.nom as produit_nom, p.prix_unitaire_b2c
             FROM abonnements a
             JOIN clients c ON a.client_id = c.id
             JOIN produits p ON a.produit_id = p.id
             WHERE a.tenant_id = $1 AND a.deleted_at IS NULL
             ORDER BY a.actif DESC, a.jour_livraison`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { client_id, produit_id, quantite, frequence, jour_livraison } = req.body;
        if (!client_id || !produit_id || !jour_livraison) {
            return res.status(400).json({ erreur: 'Client, produit et jour de livraison sont requis.' });
        }
        try {
            const result = await req.db.query(
                `INSERT INTO abonnements (tenant_id, client_id, produit_id, quantite, frequence, jour_livraison, actif)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
                [req.user.tenant_id, client_id, produit_id, quantite || 1, frequence || 'HEBDOMADAIRE', jour_livraison]
            );
            await req.db.query(`UPDATE clients SET est_abonne = TRUE WHERE id = $1 AND tenant_id = $2`, [client_id, req.user.tenant_id]);
            await logAudit(req.db, { table: 'abonnements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'abonnement." });
        }
    });

    router.put('/:id/statut', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { actif } = req.body;
        const result = await req.db.query(
            `UPDATE abonnements SET actif = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
            [!!actif, req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Abonnement introuvable.' });
        await logAudit(req.db, { table: 'abonnements', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { actif } });
        res.json(result.rows[0]);
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        await req.db.query(`UPDATE abonnements SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
        await logAudit(req.db, { table: 'abonnements', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    /**
     * Génère les commandes B2C du jour pour tous les abonnements actifs dont le jour de livraison
     * correspond au jour de la semaine courant (paniers récurrents). Applique la même logique de
     * réservation de stock et de tarification que la création manuelle de commande.
     */
    router.post('/generer-commandes', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        // Le Sénégal (Dakar) est en GMT+0, comme UTC : on utilise getUTCDay() pour ne pas dépendre
        // du fuseau horaire local de la machine qui héberge le serveur.
        const JOURS = ['DIMANCHE', 'LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
        const jourDuJour = JOURS[new Date().getUTCDay()];

        // Toute la fonction est protégée : une erreur non rattrapée ici (y compris hors de la boucle,
        // ex. journal d'audit) laisserait sinon la requête sans réponse au lieu de renvoyer une 500.
        try {

        const tenantId = req.user.tenant_id;
        const abonnements = await req.db.query(
            `SELECT a.*, p.nom as produit_nom, p.prix_unitaire_b2c, s.quantite_disponible
             FROM abonnements a
             JOIN produits p ON a.produit_id = p.id
             JOIN stocks s ON s.produit_id = p.id
             WHERE a.tenant_id = $1 AND a.actif = TRUE AND a.deleted_at IS NULL AND a.jour_livraison = $2`,
            [tenantId, jourDuJour]
        );

        const resultats = { creees: 0, echecs: [] };

        // Une connexion dédiée à la requête (req.db) suffit : chaque itération termine sa propre
        // transaction (COMMIT/ROLLBACK) avant que la suivante n'en ouvre une nouvelle, donc pas de
        // besoin d'une connexion séparée par abonnement.
        const client = req.db;
        for (const ab of abonnements.rows) {
            try {
                await client.query('BEGIN');

                // Verrouille la ligne d'abonnement : si deux déclenchements de génération se
                // chevauchent (bouton manuel + tâche planifiée par ex.), le second attend que le
                // premier valide avant de faire son propre contrôle anti-doublon ci-dessous.
                await client.query(`SELECT id FROM abonnements WHERE id = $1 FOR UPDATE`, [ab.id]);

                const dejaGeneree = await client.query(
                    `SELECT c.id FROM commandes c
                     JOIN lignes_commande lc ON lc.commande_id = c.id
                     WHERE c.tenant_id = $1 AND c.client_id = $2 AND lc.produit_id = $3 AND c.cree_le >= $4`,
                    [tenantId, ab.client_id, ab.produit_id, new Date().toISOString().slice(0, 10)]
                );
                if (dejaGeneree.rows.length > 0) {
                    await client.query('ROLLBACK');
                    continue;
                }

                const stockRes = await client.query(`SELECT quantite_disponible FROM stocks WHERE produit_id = $1 FOR UPDATE`, [ab.produit_id]);
                const disponible = Number(stockRes.rows[0]?.quantite_disponible || 0);
                if (disponible < ab.quantite) {
                    throw new Error(`Stock insuffisant pour ${ab.produit_nom}`);
                }

                const montant = Number(ab.prix_unitaire_b2c) * Number(ab.quantite);
                const numero = `ABO-${Date.now().toString().slice(-6)}-${ab.id}`;
                const commande = await client.query(
                    `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, 'EN_ATTENTE', $4) RETURNING id`,
                    [tenantId, numero, ab.client_id, montant]
                );
                await client.query(
                    `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, $3, $4, $5)`,
                    [commande.rows[0].id, ab.produit_id, ab.quantite, ab.prix_unitaire_b2c, montant]
                );
                await client.query(
                    `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, quantite_reservee_b2c = quantite_reservee_b2c + $2 WHERE produit_id = $3`,
                    [-ab.quantite, ab.quantite, ab.produit_id]
                );
                await client.query(
                    `INSERT INTO factures (tenant_id, commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, $3, 'A_PAYER', $4)`,
                    [tenantId, commande.rows[0].id, new Date().toISOString().slice(0, 10), montant]
                );

                await client.query('COMMIT');
                resultats.creees += 1;
            } catch (err) {
                await client.query('ROLLBACK');
                resultats.echecs.push({ abonnement_id: ab.id, produit: ab.produit_nom, erreur: err.message });
            }
        }

        await logAudit(req.db, { table: 'commandes', action: 'CREATE', userId: req.user.id, tenantId, details: { source: 'abonnements', ...resultats } });
        res.json({ jour: jourDuJour, ...resultats });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la génération des commandes récurrentes.' });
        }
    });

    return router;
};

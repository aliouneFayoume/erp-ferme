const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ROLES_APPRO = ['admin', 'comptable'];

module.exports = function fournisseursRoutes(pool) {
    const router = express.Router();

    // -------------------- Annuaire fournisseurs --------------------

    /**
     * Liste des fournisseurs avec suivi des délais de livraison (cahier des charges : suivi des
     * délais fournisseurs). Calculé en JS plutôt qu'en SQL (arithmétique de dates) pour rester
     * portable pg-mem/PostgreSQL, même contrainte que le dashboard et le rapprochement bancaire.
     */
    router.get('/', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const [fournisseurs, commandesRecues] = await Promise.all([
            pool.query(`SELECT * FROM fournisseurs WHERE deleted_at IS NULL ORDER BY nom`),
            pool.query(
                `SELECT fournisseur_id, date_commande, date_livraison_prevue, date_livraison_reelle
                 FROM commandes_fournisseurs
                 WHERE statut = 'RECUE' AND date_livraison_reelle IS NOT NULL AND deleted_at IS NULL`
            ),
        ]);

        const parFournisseur = new Map();
        for (const c of commandesRecues.rows) {
            if (!parFournisseur.has(c.fournisseur_id)) parFournisseur.set(c.fournisseur_id, []);
            parFournisseur.get(c.fournisseur_id).push(c);
        }

        const avecDelais = fournisseurs.rows.map((f) => {
            const commandes = parFournisseur.get(f.id) || [];
            if (commandes.length === 0) {
                return { ...f, nb_livraisons: 0, delai_moyen_jours: null, taux_retard: null };
            }
            let totalJours = 0;
            let enRetard = 0;
            for (const c of commandes) {
                const jours = (new Date(c.date_livraison_reelle).getTime() - new Date(c.date_commande).getTime()) / 86400000;
                totalJours += jours;
                if (c.date_livraison_prevue && new Date(c.date_livraison_reelle).getTime() > new Date(c.date_livraison_prevue).getTime()) {
                    enRetard++;
                }
            }
            return {
                ...f,
                nb_livraisons: commandes.length,
                delai_moyen_jours: Math.round((totalJours / commandes.length) * 10) / 10,
                taux_retard: Math.round((enRetard / commandes.length) * 100),
            };
        });

        res.json(avecDelais);
    });

    router.post('/', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const { nom, categorie, telephone, email, adresse, notes } = req.body;
        if (!nom) return res.status(400).json({ erreur: 'Le nom du fournisseur est requis.' });
        try {
            const result = await pool.query(
                `INSERT INTO fournisseurs (nom, categorie, telephone, email, adresse, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [nom, categorie || null, telephone || null, email || null, adresse || null, notes || null, req.user.id]
            );
            await logAudit(pool, { table: 'fournisseurs', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du fournisseur.' });
        }
    });

    router.put('/:id', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const { nom, categorie, telephone, email, adresse, notes } = req.body;
        try {
            const result = await pool.query(
                `UPDATE fournisseurs SET nom = COALESCE($1, nom), categorie = COALESCE($2, categorie),
                        telephone = COALESCE($3, telephone), email = COALESCE($4, email),
                        adresse = COALESCE($5, adresse), notes = COALESCE($6, notes)
                 WHERE id = $7 AND deleted_at IS NULL RETURNING *`,
                [nom, categorie, telephone, email, adresse, notes, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Fournisseur introuvable.' });
            await logAudit(pool, { table: 'fournisseurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du fournisseur.' });
        }
    });

    router.delete('/:id', requireAuth, checkRole(['admin']), async (req, res) => {
        await pool.query(`UPDATE fournisseurs SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.params.id]);
        await logAudit(pool, { table: 'fournisseurs', rowId: req.params.id, action: 'DELETE', userId: req.user.id });
        res.status(204).end();
    });

    // -------------------- Alertes de réapprovisionnement --------------------
    // Réutilise stocks.seuil_alerte (déjà affiché comme badge stock bas dans le Catalogue).

    router.get('/reappro-alertes', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const result = await pool.query(
            `SELECT p.id as produit_id, p.nom as produit_nom, s.nom as secteur_nom,
                    st.quantite_disponible, st.seuil_alerte
             FROM stocks st
             JOIN produits p ON p.id = st.produit_id
             JOIN secteurs s ON s.id = p.secteur_id
             WHERE p.deleted_at IS NULL AND p.actif = TRUE AND st.quantite_disponible <= st.seuil_alerte
             ORDER BY st.quantite_disponible - st.seuil_alerte`
        );
        res.json(result.rows);
    });

    // -------------------- Commandes fournisseurs (achats) --------------------

    router.get('/commandes', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const result = await pool.query(
            `SELECT cf.*, f.nom as fournisseur_nom,
                    (SELECT COUNT(*) FROM lignes_commande_fournisseur WHERE commande_fournisseur_id = cf.id) as nb_lignes
             FROM commandes_fournisseurs cf
             JOIN fournisseurs f ON f.id = cf.fournisseur_id
             WHERE cf.deleted_at IS NULL ORDER BY cf.cree_le DESC LIMIT 200`
        );
        res.json(result.rows);
    });

    router.get('/commandes/:id', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const commande = await pool.query(
            `SELECT cf.*, f.nom as fournisseur_nom FROM commandes_fournisseurs cf
             JOIN fournisseurs f ON f.id = cf.fournisseur_id WHERE cf.id = $1`,
            [req.params.id]
        );
        if (commande.rows.length === 0) return res.status(404).json({ erreur: 'Commande fournisseur introuvable.' });
        const lignes = await pool.query(
            `SELECT lcf.*, p.nom as produit_nom FROM lignes_commande_fournisseur lcf
             JOIN produits p ON lcf.produit_id = p.id WHERE lcf.commande_fournisseur_id = $1`,
            [req.params.id]
        );
        res.json({ ...commande.rows[0], lignes: lignes.rows });
    });

    router.post('/commandes', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const { fournisseur_id, date_livraison_prevue, notes, lignes } = req.body;
        if (!fournisseur_id || !Array.isArray(lignes) || lignes.length === 0) {
            return res.status(400).json({ erreur: 'Fournisseur et au moins une ligne sont requis.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const fournisseurRes = await client.query(`SELECT * FROM fournisseurs WHERE id = $1 AND deleted_at IS NULL`, [fournisseur_id]);
            if (fournisseurRes.rows.length === 0) throw { statut: 404, message: 'Fournisseur introuvable.' };

            let montantTotal = 0;
            const lignesPreparees = [];
            for (const ligne of lignes) {
                const produitRes = await client.query(`SELECT * FROM produits WHERE id = $1 AND deleted_at IS NULL`, [ligne.produit_id]);
                if (produitRes.rows.length === 0) throw { statut: 404, message: `Produit ${ligne.produit_id} introuvable.` };
                const quantite = Number(ligne.quantite);
                const prixUnitaire = Number(ligne.prix_unitaire);
                if (!(quantite > 0) || !(prixUnitaire >= 0)) {
                    throw { statut: 400, message: 'Quantité et prix unitaire doivent être positifs.' };
                }
                const sousTotal = quantite * prixUnitaire;
                montantTotal += sousTotal;
                lignesPreparees.push({ produit_id: produitRes.rows[0].id, quantite, prixUnitaire, sousTotal });
            }

            const numero = `CMF-${Date.now().toString().slice(-6)}`;
            const commandeRes = await client.query(
                `INSERT INTO commandes_fournisseurs (numero_commande, fournisseur_id, date_livraison_prevue, montant_total, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [numero, fournisseur_id, date_livraison_prevue || null, montantTotal, notes || null, req.user.id]
            );
            const commande = commandeRes.rows[0];

            for (const l of lignesPreparees) {
                await client.query(
                    `INSERT INTO lignes_commande_fournisseur (commande_fournisseur_id, produit_id, quantite, prix_unitaire, sous_total)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [commande.id, l.produit_id, l.quantite, l.prixUnitaire, l.sousTotal]
                );
            }

            await client.query('COMMIT');
            await logAudit(pool, { table: 'commandes_fournisseurs', rowId: commande.id, action: 'CREATE', userId: req.user.id, details: { montantTotal, fournisseur_id } });
            res.status(201).json({ ...commande, lignes: lignesPreparees });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) {
                res.status(err.statut).json({ erreur: err.message });
            } else {
                console.error(err);
                res.status(500).json({ erreur: 'Erreur lors de la création de la commande fournisseur.' });
            }
        } finally {
            client.release();
        }
    });

    /**
     * Réception d'une commande fournisseur : crédite le stock des produits reçus et génère
     * automatiquement la dépense correspondante — miroir du débit de stock + facture générés à la
     * création d'une commande client (routes/commandes.js).
     */
    router.put('/commandes/:id/recevoir', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const commandeRes = await client.query(
                `SELECT * FROM commandes_fournisseurs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
                [req.params.id]
            );
            if (commandeRes.rows.length === 0) throw { statut: 404, message: 'Commande fournisseur introuvable.' };
            const commande = commandeRes.rows[0];
            if (commande.statut !== 'COMMANDEE') {
                throw { statut: 400, message: 'Seule une commande au statut "Commandée" peut être réceptionnée.' };
            }

            const fournisseurRes = await client.query(`SELECT * FROM fournisseurs WHERE id = $1`, [commande.fournisseur_id]);
            const fournisseur = fournisseurRes.rows[0];

            const lignes = await client.query(`SELECT * FROM lignes_commande_fournisseur WHERE commande_fournisseur_id = $1`, [commande.id]);
            for (const ligne of lignes.rows) {
                await client.query(
                    `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, derniere_mise_a_jour = CURRENT_TIMESTAMP
                     WHERE produit_id = $2`,
                    [ligne.quantite, ligne.produit_id]
                );
            }

            const aujourdhui = new Date().toISOString().slice(0, 10);
            const updated = await client.query(
                `UPDATE commandes_fournisseurs SET statut = 'RECUE', date_livraison_reelle = $1 WHERE id = $2 RETURNING *`,
                [aujourdhui, commande.id]
            );

            const depenseRes = await client.query(
                `INSERT INTO depenses (categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                [
                    fournisseur?.categorie || 'Autre',
                    commande.montant_total,
                    `Réception commande ${commande.numero_commande} — ${fournisseur?.nom || 'fournisseur'}`,
                    aujourdhui,
                    req.user.id,
                ]
            );

            await client.query('COMMIT');
            await logAudit(pool, {
                table: 'commandes_fournisseurs',
                rowId: commande.id,
                action: 'UPDATE',
                userId: req.user.id,
                details: { statut: 'RECUE', depense_id: depenseRes.rows[0].id },
            });
            res.json(updated.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la réception de la commande.' });
        } finally {
            client.release();
        }
    });

    router.put('/commandes/:id/annuler', requireAuth, checkRole(ROLES_APPRO), async (req, res) => {
        const result = await pool.query(
            `UPDATE commandes_fournisseurs SET statut = 'ANNULEE'
             WHERE id = $1 AND statut = 'COMMANDEE' AND deleted_at IS NULL RETURNING *`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ erreur: 'Seule une commande au statut "Commandée" peut être annulée.' });
        }
        await logAudit(pool, { table: 'commandes_fournisseurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { statut: 'ANNULEE' } });
        res.json(result.rows[0]);
    });

    return router;
};

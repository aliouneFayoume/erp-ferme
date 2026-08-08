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
    router.get('/', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const [fournisseurs, commandesRecues] = await Promise.all([
            req.db.query(`SELECT * FROM fournisseurs WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY nom`, [tenantId]),
            req.db.query(
                `SELECT fournisseur_id, date_commande, date_livraison_prevue, date_livraison_reelle
                 FROM commandes_fournisseurs
                 WHERE tenant_id = $1 AND statut = 'RECUE' AND date_livraison_reelle IS NOT NULL AND deleted_at IS NULL`,
                [tenantId]
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

    router.post('/', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom, categorie, telephone, email, adresse, notes } = req.body;
        if (!nom) return res.status(400).json({ erreur: 'Le nom du fournisseur est requis.' });
        try {
            const result = await req.db.query(
                `INSERT INTO fournisseurs (tenant_id, nom, categorie, telephone, email, adresse, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [tenantId, nom, categorie || null, telephone || null, email || null, adresse || null, notes || null, req.user.id]
            );
            await logAudit(req.db, { table: 'fournisseurs', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du fournisseur.' });
        }
    });

    router.put('/:id', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom, categorie, telephone, email, adresse, notes } = req.body;
        try {
            const result = await req.db.query(
                `UPDATE fournisseurs SET nom = COALESCE($1, nom), categorie = COALESCE($2, categorie),
                        telephone = COALESCE($3, telephone), email = COALESCE($4, email),
                        adresse = COALESCE($5, adresse), notes = COALESCE($6, notes)
                 WHERE id = $7 AND tenant_id = $8 AND deleted_at IS NULL RETURNING *`,
                [nom, categorie, telephone, email, adresse, notes, req.params.id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Fournisseur introuvable.' });
            await logAudit(req.db, { table: 'fournisseurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du fournisseur.' });
        }
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        await req.db.query(`UPDATE fournisseurs SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
        await logAudit(req.db, { table: 'fournisseurs', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    // -------------------- Alertes de réapprovisionnement --------------------
    // Réutilise stocks.seuil_alerte (déjà affiché comme badge stock bas dans le Catalogue).

    router.get('/reappro-alertes', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const result = await req.db.query(
            `SELECT p.id as produit_id, p.nom as produit_nom, s.nom as secteur_nom,
                    st.quantite_disponible, st.seuil_alerte
             FROM stocks st
             JOIN produits p ON p.id = st.produit_id
             JOIN secteurs s ON s.id = p.secteur_id
             WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.actif = TRUE AND st.quantite_disponible <= st.seuil_alerte
             ORDER BY st.quantite_disponible - st.seuil_alerte`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    // -------------------- Commandes fournisseurs (achats) --------------------

    router.get('/commandes', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const result = await req.db.query(
            `SELECT cf.*, f.nom as fournisseur_nom
             FROM commandes_fournisseurs cf
             JOIN fournisseurs f ON f.id = cf.fournisseur_id
             WHERE cf.tenant_id = $1 AND cf.deleted_at IS NULL ORDER BY cf.cree_le DESC LIMIT 200`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.get('/commandes/:id', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const commande = await req.db.query(
            `SELECT cf.*, f.nom as fournisseur_nom FROM commandes_fournisseurs cf
             JOIN fournisseurs f ON f.id = cf.fournisseur_id WHERE cf.id = $1 AND cf.tenant_id = $2`,
            [req.params.id, tenantId]
        );
        if (commande.rows.length === 0) return res.status(404).json({ erreur: 'Commande fournisseur introuvable.' });
        const lignes = await req.db.query(
            `SELECT * FROM lignes_commande_fournisseur WHERE commande_fournisseur_id = $1`,
            [req.params.id]
        );
        res.json({ ...commande.rows[0], lignes: lignes.rows });
    });

    router.post('/commandes', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { fournisseur_id, date_livraison_prevue, notes, lignes } = req.body;
        if (!fournisseur_id || !Array.isArray(lignes) || lignes.length === 0) {
            return res.status(400).json({ erreur: 'Fournisseur et au moins une ligne sont requis.' });
        }

        const client = req.db;
        try {
            await client.query('BEGIN');

            const fournisseurRes = await client.query(`SELECT * FROM fournisseurs WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [fournisseur_id, tenantId]);
            if (fournisseurRes.rows.length === 0) throw { statut: 404, message: 'Fournisseur introuvable.' };

            let montantTotal = 0;
            const lignesPreparees = [];
            for (const ligne of lignes) {
                const designation = String(ligne.designation || '').trim();
                const quantite = Number(ligne.quantite);
                const prixUnitaire = Number(ligne.prix_unitaire);
                if (!designation) throw { statut: 400, message: 'La désignation de chaque article est requise.' };
                if (!(quantite > 0) || !(prixUnitaire >= 0)) {
                    throw { statut: 400, message: 'Quantité et prix unitaire doivent être positifs.' };
                }
                const sousTotal = quantite * prixUnitaire;
                montantTotal += sousTotal;
                lignesPreparees.push({ designation, unite: ligne.unite || null, quantite, prixUnitaire, sousTotal });
            }

            const numero = `CMF-${Date.now().toString().slice(-6)}`;
            // date_commande fixée explicitement en JS (plutôt que de laisser le DEFAULT CURRENT_DATE
            // de la colonne s'appliquer) : le calcul du délai de livraison compare cette date à
            // date_livraison_reelle, elle aussi calculée en JS (voir /recevoir plus bas) — mélanger une
            // date par défaut évaluée côté SQL avec une date calculée côté JS peut introduire un écart
            // artificiel selon le fuseau horaire du moteur SQL (déjà rencontré avec CURRENT_DATE en pg-mem).
            const aujourdhui = new Date().toISOString().slice(0, 10);
            const commandeRes = await client.query(
                `INSERT INTO commandes_fournisseurs (tenant_id, numero_commande, fournisseur_id, date_commande, date_livraison_prevue, montant_total, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
                [tenantId, numero, fournisseur_id, aujourdhui, date_livraison_prevue || null, montantTotal, notes || null, req.user.id]
            );
            const commande = commandeRes.rows[0];

            for (const l of lignesPreparees) {
                await client.query(
                    `INSERT INTO lignes_commande_fournisseur (commande_fournisseur_id, designation, unite, quantite, prix_unitaire, sous_total)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [commande.id, l.designation, l.unite, l.quantite, l.prixUnitaire, l.sousTotal]
                );
            }

            await client.query('COMMIT');
            await logAudit(req.db, { table: 'commandes_fournisseurs', rowId: commande.id, action: 'CREATE', userId: req.user.id, tenantId, details: { montantTotal, fournisseur_id } });
            res.status(201).json({ ...commande, lignes: lignesPreparees });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) {
                res.status(err.statut).json({ erreur: err.message });
            } else {
                console.error(err);
                res.status(500).json({ erreur: 'Erreur lors de la création de la commande fournisseur.' });
            }
        }
    });

    /**
     * Réception d'une commande fournisseur : génère automatiquement la dépense correspondante —
     * miroir de la facture générée à la création d'une commande client (routes/commandes.js).
     * Ne touche pas `stocks`/`produits` : les lignes portent sur des intrants achetés (aliment,
     * vaccins, semences...), sans rapport avec le catalogue des produits vendus aux clients.
     */
    router.put('/commandes/:id/recevoir', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const client = req.db;
        try {
            await client.query('BEGIN');

            const commandeRes = await client.query(
                `SELECT * FROM commandes_fournisseurs WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
                [req.params.id, tenantId]
            );
            if (commandeRes.rows.length === 0) throw { statut: 404, message: 'Commande fournisseur introuvable.' };
            const commande = commandeRes.rows[0];
            if (commande.statut !== 'COMMANDEE') {
                throw { statut: 400, message: 'Seule une commande au statut "Commandée" peut être réceptionnée.' };
            }

            const fournisseurRes = await client.query(`SELECT * FROM fournisseurs WHERE id = $1 AND tenant_id = $2`, [commande.fournisseur_id, tenantId]);
            const fournisseur = fournisseurRes.rows[0];

            const aujourdhui = new Date().toISOString().slice(0, 10);
            const updated = await client.query(
                `UPDATE commandes_fournisseurs SET statut = 'RECUE', date_livraison_reelle = $1 WHERE id = $2 RETURNING *`,
                [aujourdhui, commande.id]
            );

            const depenseRes = await client.query(
                `INSERT INTO depenses (tenant_id, categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [
                    tenantId,
                    fournisseur?.categorie || 'Autre',
                    commande.montant_total,
                    `Réception commande ${commande.numero_commande} — ${fournisseur?.nom || 'fournisseur'}`,
                    aujourdhui,
                    req.user.id,
                ]
            );

            await client.query('COMMIT');
            await logAudit(req.db, {
                table: 'commandes_fournisseurs',
                rowId: commande.id,
                action: 'UPDATE',
                userId: req.user.id,
                tenantId,
                details: { statut: 'RECUE', depense_id: depenseRes.rows[0].id },
            });
            res.json(updated.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la réception de la commande.' });
        }
    });

    router.put('/commandes/:id/annuler', requireAuth(pool), checkRole(ROLES_APPRO), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const result = await req.db.query(
            `UPDATE commandes_fournisseurs SET statut = 'ANNULEE'
             WHERE id = $1 AND tenant_id = $2 AND statut = 'COMMANDEE' AND deleted_at IS NULL RETURNING *`,
            [req.params.id, tenantId]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ erreur: 'Seule une commande au statut "Commandée" peut être annulée.' });
        }
        await logAudit(req.db, { table: 'commandes_fournisseurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: { statut: 'ANNULEE' } });
        res.json(result.rows[0]);
    });

    return router;
};

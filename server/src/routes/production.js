const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

// Un chef de prod ne doit lire/écrire que les lots de son propre secteur (admin/comptable illimités).
async function verifierAccesLot(pool, lotId, user) {
    if (user.role !== 'chef_prod' || !user.secteur_id) return true;
    const lot = await pool.query(`SELECT secteur_id FROM lots_production WHERE id = $1`, [lotId]);
    return lot.rows.length > 0 && Number(lot.rows[0].secteur_id) === Number(user.secteur_id);
}

module.exports = function productionRoutes(pool) {
    const router = express.Router();

    router.get('/secteurs', requireAuth, async (req, res) => {
        const result = await pool.query(`SELECT * FROM secteurs ORDER BY id`);
        res.json(result.rows);
    });

    // Un chef de prod ne voit que les lots de son secteur ; admin/comptable voient tout.
    router.get('/lots', requireAuth, async (req, res) => {
        try {
            const params = [];
            let where = `l.deleted_at IS NULL`;
            if (req.user.role === 'chef_prod' && req.user.secteur_id) {
                params.push(req.user.secteur_id);
                where += ` AND l.secteur_id = $${params.length}`;
            } else if (req.query.secteur_id) {
                params.push(req.query.secteur_id);
                where += ` AND l.secteur_id = $${params.length}`;
            }

            const result = await pool.query(
                `SELECT l.*, s.nom as secteur_nom FROM lots_production l
                 JOIN secteurs s ON l.secteur_id = s.id
                 WHERE ${where} ORDER BY l.date_demarrage DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des lots.' });
        }
    });

    router.post('/lots', requireAuth, checkRole(['chef_prod']), async (req, res) => {
        const { secteur_id, code_lot, quantite_initiale, date_demarrage, culture, duree_maturite_jours } = req.body;
        if (req.user.role === 'chef_prod' && req.user.secteur_id && Number(secteur_id) !== Number(req.user.secteur_id)) {
            return res.status(403).json({ erreur: 'Vous ne pouvez créer un lot que pour votre secteur.' });
        }
        try {
            const result = await pool.query(
                `INSERT INTO lots_production (secteur_id, code_lot, quantite_initiale, date_demarrage, statut, culture, duree_maturite_jours, cree_par)
                 VALUES ($1, $2, $3, $4, 'EN_COURS', $5, $6, $7) RETURNING *`,
                [secteur_id, code_lot, quantite_initiale, date_demarrage, culture || null, duree_maturite_jours || null, req.user.id]
            );
            await logAudit(pool, { table: 'lots_production', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du lot.' });
        }
    });

    // Clôture d'un lot une fois la récolte/l'abattage effectué (ou déclaration de perte).
    router.put('/lots/:id/statut', requireAuth, checkRole(['chef_prod']), async (req, res) => {
        const { statut } = req.body;
        const statutsValides = ['EN_COURS', 'ABATTAGE', 'TERMINE', 'PERDU'];
        if (!statutsValides.includes(statut)) {
            return res.status(400).json({ erreur: 'Statut invalide.' });
        }
        if (!(await verifierAccesLot(pool, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
        }
        try {
            const result = await pool.query(
                `UPDATE lots_production SET statut = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
                [statut, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Lot introuvable.' });
            await logAudit(pool, { table: 'lots_production', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, details: { statut } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la clôture du lot.' });
        }
    });

    router.get('/releves', requireAuth, async (req, res) => {
        const { lot_id } = req.query;

        if (lot_id) {
            if (!(await verifierAccesLot(pool, lot_id, req.user))) {
                return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
            }
            const result = await pool.query(
                `SELECT * FROM releves_journaliers WHERE lot_id = $1 ORDER BY date_releve DESC LIMIT 100`,
                [lot_id]
            );
            return res.json(result.rows);
        }

        // Pas de lot_id précis : un chef de prod ne doit voir que les relevés de son propre secteur.
        if (req.user.role === 'chef_prod' && req.user.secteur_id) {
            const result = await pool.query(
                `SELECT r.* FROM releves_journaliers r JOIN lots_production l ON r.lot_id = l.id
                 WHERE l.secteur_id = $1 ORDER BY r.date_releve DESC LIMIT 100`,
                [req.user.secteur_id]
            );
            return res.json(result.rows);
        }

        const result = await pool.query(`SELECT * FROM releves_journaliers ORDER BY date_releve DESC LIMIT 100`);
        res.json(result.rows);
    });

    /**
     * Route critique pour la PWA : synchronisation des relevés saisis hors-ligne.
     * Le front envoie le tableau accumulé dans la file locale (localStorage/IndexedDB).
     */
    router.post('/sync', requireAuth, checkRole(['chef_prod']), async (req, res) => {
        const { releves } = req.body;
        if (!releves || !Array.isArray(releves)) {
            return res.status(400).json({ erreur: 'Format de données invalide' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            for (const releve of releves) {
                if (!(await verifierAccesLot(pool, releve.lot_id, req.user))) {
                    throw { statut: 403, message: `Le lot ${releve.lot_id} ne relève pas de votre secteur.` };
                }

                await client.query(
                    `INSERT INTO releves_journaliers
                     (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, taille_moyenne_cm, temperature_eau, ph_eau, intrants_utilises, quantite_recoltee_kg, notes, est_synchronise)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE)`,
                    [
                        releve.lot_id,
                        req.user.id,
                        releve.date_releve,
                        releve.mortalite || 0,
                        releve.conso_aliment_kg || 0,
                        releve.poids_moyen_g || 0,
                        releve.taille_moyenne_cm || null,
                        releve.temperature_eau || null,
                        releve.ph_eau || null,
                        releve.intrants_utilises || null,
                        releve.quantite_recoltee_kg || null,
                        releve.notes || null,
                    ]
                );

                if (releve.mortalite > 0) {
                    await client.query(
                        `UPDATE lots_production SET quantite_initiale = quantite_initiale + $1 WHERE id = $2`,
                        [-releve.mortalite, releve.lot_id]
                    );
                }
            }

            await client.query('COMMIT');
            await logAudit(pool, { table: 'releves_journaliers', action: 'CREATE', userId: req.user.id, details: { count: releves.length } });
            res.status(200).json({ message: `${releves.length} relevé(s) synchronisé(s) avec succès.` });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error('Erreur de synchronisation:', err);
            res.status(500).json({ erreur: 'Échec de la synchronisation des données de production.' });
        } finally {
            client.release();
        }
    });

    // FCR = aliment consommé (kg) / gain de poids produit (kg) — indicateur clé Avicole/Piscicole
    router.get('/lots/:id/fcr', requireAuth, async (req, res) => {
        try {
            const lot = await pool.query(`SELECT * FROM lots_production WHERE id = $1`, [req.params.id]);
            if (lot.rows.length === 0) return res.status(404).json({ erreur: 'Lot introuvable.' });
            if (!(await verifierAccesLot(pool, req.params.id, req.user))) {
                return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
            }

            const releves = await pool.query(
                `SELECT * FROM releves_journaliers WHERE lot_id = $1 ORDER BY date_releve ASC`,
                [req.params.id]
            );

            const totalAliment = releves.rows.reduce((s, r) => s + Number(r.conso_aliment_kg || 0), 0);
            const dernierPoids = releves.rows.length ? Number(releves.rows[releves.rows.length - 1].poids_moyen_g || 0) : 0;
            const effectifRestant = Number(lot.rows[0].quantite_initiale || 0);
            const gainKg = (dernierPoids * effectifRestant) / 1000;
            const fcr = gainKg > 0 ? totalAliment / gainKg : null;

            res.json({
                lot_id: Number(req.params.id),
                total_aliment_kg: totalAliment,
                poids_moyen_g: dernierPoids,
                effectif_restant: effectifRestant,
                fcr: fcr ? Number(fcr.toFixed(2)) : null,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du calcul du FCR.' });
        }
    });

    return router;
};

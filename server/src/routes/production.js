const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

// Un utilisateur ne doit jamais accéder à un lot d'une autre organisation, quel que soit son rôle ;
// un chef de prod est en plus restreint à son propre secteur au sein de son organisation.
async function verifierAccesLot(db, lotId, user) {
    const lot = await db.query(`SELECT tenant_id, secteur_id FROM lots_production WHERE id = $1`, [lotId]);
    if (lot.rows.length === 0) return false;
    if (Number(lot.rows[0].tenant_id) !== Number(user.tenant_id)) return false;
    if (user.role === 'chef_prod' && user.secteur_id) {
        return Number(lot.rows[0].secteur_id) === Number(user.secteur_id);
    }
    return true;
}

// Espèce présente dans un bassin (Piscicole) : texte libre court. Renvoie null (vide/absent), la chaîne nettoyée,
// ou false si elle est trop longue. Un bassin change d'espèce au gré des déplacements de poissons.
const ESPECE_MAX = 100;
function normaliserEspece(valeur) {
    if (valeur === undefined || valeur === null) return null;
    const texte = String(valeur).trim();
    if (texte === '') return null;
    return texte.length > ESPECE_MAX ? false : texte;
}

module.exports = function productionRoutes(pool) {
    const router = express.Router();

    router.get('/secteurs', requireAuth(pool), async (req, res) => {
        const result = await req.db.query(`SELECT * FROM secteurs WHERE tenant_id = $1 ORDER BY id`, [req.user.tenant_id]);
        res.json(result.rows);
    });

    /**
     * Définit (ou retire, avec intrant_id null) l'intrant "aliment par défaut" d'un secteur — voir
     * la déduction automatique dans POST /sync ci-dessous.
     */
    router.put('/secteurs/:id/aliment-defaut', requireAuth(pool), checkRole(['chef_prod', 'comptable']), async (req, res) => {
        const intrantId = req.body.intrant_id || null;
        if (intrantId) {
            const intrantRes = await req.db.query(`SELECT id FROM intrants WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [intrantId, req.user.tenant_id]);
            if (intrantRes.rows.length === 0) return res.status(400).json({ erreur: 'Intrant invalide.' });
        }
        const result = await req.db.query(
            `UPDATE secteurs SET intrant_alimentation_id = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *`,
            [intrantId, req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Secteur introuvable.' });
        await logAudit(req.db, { req, table: 'secteurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { intrant_alimentation_id: intrantId } });
        res.json(result.rows[0]);
    });

    /**
     * Définit (ou retire, avec produit_id null) le produit du catalogue alimenté automatiquement
     * par le ramassage du jour d'un secteur (ex: Avicole → "Œufs (plateau de 30)") — voir la
     * conversion automatique dans POST /sync ci-dessous.
     */
    router.put('/secteurs/:id/produit-oeufs', requireAuth(pool), checkRole(['chef_prod', 'comptable']), async (req, res) => {
        const produitId = req.body.produit_id || null;
        const oeufsParPlateau = req.body.oeufs_par_plateau != null ? Number(req.body.oeufs_par_plateau) : 30;
        if (!(oeufsParPlateau > 0)) return res.status(400).json({ erreur: 'Le nombre d\'œufs par plateau doit être supérieur à zéro.' });
        if (produitId) {
            const produitRes = await req.db.query(`SELECT id FROM produits WHERE id = $1 AND tenant_id = $2`, [produitId, req.user.tenant_id]);
            if (produitRes.rows.length === 0) return res.status(400).json({ erreur: 'Produit invalide.' });
        }
        const result = await req.db.query(
            `UPDATE secteurs SET produit_oeufs_id = $1, oeufs_par_plateau = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
            [produitId, oeufsParPlateau, req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Secteur introuvable.' });
        await logAudit(req.db, { req, table: 'secteurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { produit_oeufs_id: produitId, oeufs_par_plateau: oeufsParPlateau } });
        res.json(result.rows[0]);
    });

    // Un chef de prod ne voit que les lots de son secteur ; admin/comptable voient tout ceux de leur organisation.
    router.get('/lots', requireAuth(pool), async (req, res) => {
        try {
            const params = [req.user.tenant_id];
            let where = `l.tenant_id = $1 AND l.deleted_at IS NULL`;
            if (req.user.role === 'chef_prod' && req.user.secteur_id) {
                params.push(req.user.secteur_id);
                where += ` AND l.secteur_id = $${params.length}`;
            } else if (req.query.secteur_id) {
                params.push(req.query.secteur_id);
                where += ` AND l.secteur_id = $${params.length}`;
            }

            const result = await req.db.query(
                `SELECT l.*, s.nom as secteur_nom, p.nom as secteur_parent_nom FROM lots_production l
                 JOIN secteurs s ON l.secteur_id = s.id
                 LEFT JOIN secteurs p ON p.id = s.parent_secteur_id
                 WHERE ${where} ORDER BY l.date_demarrage DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des lots.' });
        }
    });

    router.post('/lots', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const { secteur_id, code_lot, quantite_initiale, date_demarrage, culture, duree_maturite_jours } = req.body;
        if (req.user.role === 'chef_prod' && req.user.secteur_id && Number(secteur_id) !== Number(req.user.secteur_id)) {
            return res.status(403).json({ erreur: 'Vous ne pouvez créer un lot que pour votre secteur.' });
        }
        const espece = normaliserEspece(req.body.espece);
        if (espece === false) return res.status(400).json({ erreur: `L'espèce ne peut pas dépasser ${ESPECE_MAX} caractères.` });
        try {
            const secteurRes = await req.db.query(`SELECT id FROM secteurs WHERE id = $1 AND tenant_id = $2`, [secteur_id, req.user.tenant_id]);
            if (secteurRes.rows.length === 0) return res.status(400).json({ erreur: 'Secteur invalide.' });
            const result = await req.db.query(
                `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, culture, duree_maturite_jours, espece, cree_par)
                 VALUES ($1, $2, $3, $4, $5, 'EN_COURS', $6, $7, $8, $9) RETURNING *`,
                [req.user.tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, culture || null, duree_maturite_jours || null, espece, req.user.id]
            );
            await logAudit(req.db, { req, table: 'lots_production', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du lot.' });
        }
    });

    // Correction de l'effectif/date de démarrage d'un lot — utile quand la valeur saisie à la
    // création était provisoire (ex. configuration d'une ferme avant d'avoir les vrais chiffres du
    // client) ou simplement une erreur de saisie. Ne touche jamais au statut (voir route dédiée
    // ci-dessous) ni à l'historique des relevés déjà enregistrés.
    router.put('/lots/:id', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const { quantite_initiale, date_demarrage } = req.body;
        if (quantite_initiale !== undefined && !(Number(quantite_initiale) > 0)) {
            return res.status(400).json({ erreur: 'La quantité doit être un nombre positif.' });
        }
        // espece absente = inchangée ; chaîne vide = effacée (bassin vide / espèce inconnue) ; sinon remplacée.
        const especeFournie = req.body.espece !== undefined;
        const espece = normaliserEspece(req.body.espece);
        if (espece === false) return res.status(400).json({ erreur: `L'espèce ne peut pas dépasser ${ESPECE_MAX} caractères.` });
        if (!(await verifierAccesLot(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
        }
        try {
            const result = await req.db.query(
                `UPDATE lots_production SET
                    quantite_initiale = COALESCE($1, quantite_initiale),
                    date_demarrage = COALESCE($2, date_demarrage),
                    espece = CASE WHEN $3::boolean THEN $4::varchar ELSE espece END
                 WHERE id = $5 AND tenant_id = $6 AND deleted_at IS NULL RETURNING *`,
                [quantite_initiale ?? null, date_demarrage || null, especeFournie, espece, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Lot introuvable.' });
            await logAudit(req.db, { req, table: 'lots_production', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { quantite_initiale, date_demarrage, ...(especeFournie ? { espece } : {}) } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du lot.' });
        }
    });

    // Clôture d'un lot une fois la récolte/l'abattage effectué (ou déclaration de perte).
    router.put('/lots/:id/statut', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const { statut } = req.body;
        const statutsValides = ['EN_COURS', 'ABATTAGE', 'TERMINE', 'PERDU'];
        if (!statutsValides.includes(statut)) {
            return res.status(400).json({ erreur: 'Statut invalide.' });
        }
        if (!(await verifierAccesLot(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
        }
        try {
            const result = await req.db.query(
                `UPDATE lots_production SET statut = $1 WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL RETURNING *`,
                [statut, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Lot introuvable.' });
            await logAudit(req.db, { req, table: 'lots_production', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { statut } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la clôture du lot.' });
        }
    });

    router.get('/releves', requireAuth(pool), async (req, res) => {
        const { lot_id } = req.query;

        if (lot_id) {
            if (!(await verifierAccesLot(req.db, lot_id, req.user))) {
                return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
            }
            const result = await req.db.query(
                `SELECT * FROM releves_journaliers WHERE lot_id = $1 ORDER BY date_releve DESC LIMIT 100`,
                [lot_id]
            );
            return res.json(result.rows);
        }

        // Pas de lot_id précis : un chef de prod ne doit voir que les relevés de son propre secteur.
        if (req.user.role === 'chef_prod' && req.user.secteur_id) {
            const result = await req.db.query(
                `SELECT r.* FROM releves_journaliers r JOIN lots_production l ON r.lot_id = l.id
                 WHERE l.tenant_id = $1 AND l.secteur_id = $2 ORDER BY r.date_releve DESC LIMIT 100`,
                [req.user.tenant_id, req.user.secteur_id]
            );
            return res.json(result.rows);
        }

        const result = await req.db.query(
            `SELECT r.* FROM releves_journaliers r JOIN lots_production l ON r.lot_id = l.id
             WHERE l.tenant_id = $1 ORDER BY r.date_releve DESC LIMIT 100`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    /**
     * Route critique pour la PWA : synchronisation des relevés saisis hors-ligne.
     * Le front envoie le tableau accumulé dans la file locale (localStorage/IndexedDB).
     */
    router.post('/sync', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const { releves } = req.body;
        if (!releves || !Array.isArray(releves)) {
            return res.status(400).json({ erreur: 'Format de données invalide' });
        }

        const client = req.db;
        try {
            await client.query('BEGIN');

            for (const releve of releves) {
                if (!(await verifierAccesLot(req.db, releve.lot_id, req.user))) {
                    throw { statut: 403, message: `Le lot ${releve.lot_id} ne relève pas de votre secteur.` };
                }

                await client.query(
                    `INSERT INTO releves_journaliers
                     (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, taille_moyenne_cm, temperature_eau, ph_eau, intrants_utilises, quantite_recoltee_kg, oeufs_collectes, notes, est_synchronise)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, TRUE)`,
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
                        releve.oeufs_collectes || null,
                        releve.notes || null,
                    ]
                );

                if (releve.mortalite > 0) {
                    await client.query(
                        `UPDATE lots_production SET quantite_initiale = quantite_initiale + $1 WHERE id = $2`,
                        [-releve.mortalite, releve.lot_id]
                    );
                }

                // Déduction automatique du stock d'intrants (aliment) — best-effort, jamais bloquant :
                // un relevé de terrain (souvent saisi hors ligne) ne doit jamais échouer à cause d'une
                // histoire de stock. Ne s'applique que si le secteur du lot a un "aliment par défaut"
                // configuré (routes/intrants.js) ; le stock peut devenir négatif (signal à
                // investiguer) plutôt que de bloquer.
                if (releve.conso_aliment_kg > 0) {
                    // Aliment du secteur du lot (ex. "Éclosion", "Élevage larvaire", "Pregrossissement" :
                    // trois types de bassin = trois aliments différents utilisés le même jour), à défaut
                    // celui de son secteur parent (ex. "Piscicole") — jamais l'inverse, pour qu'un type de
                    // bassin puisse toujours avoir SON aliment sans toucher aux autres.
                    const secteurRes = await client.query(
                        `SELECT COALESCE(s.intrant_alimentation_id, p.intrant_alimentation_id) AS intrant_alimentation_id
                         FROM lots_production l
                         JOIN secteurs s ON s.id = l.secteur_id
                         LEFT JOIN secteurs p ON p.id = s.parent_secteur_id
                         WHERE l.id = $1`,
                        [releve.lot_id]
                    );
                    const intrantAlimentationId = secteurRes.rows[0]?.intrant_alimentation_id;
                    if (intrantAlimentationId) {
                        await client.query(`UPDATE intrants SET quantite_stock = quantite_stock - $1 WHERE id = $2`, [releve.conso_aliment_kg, intrantAlimentationId]);
                        await client.query(
                            `INSERT INTO mouvements_intrants (intrant_id, type, quantite, motif, lot_id, cree_par)
                             VALUES ($1, 'SORTIE', $2, 'RELEVE_JOURNALIER', $3, $4)`,
                            [intrantAlimentationId, releve.conso_aliment_kg, releve.lot_id, req.user.id]
                        );
                    }
                }

                // Alimentation automatique du stock vendable (ramassage — ex: œufs Avicole) — même
                // philosophie best-effort/non-bloquante que la déduction d'aliment ci-dessus. Le reste
                // non conditionné (< 1 plateau) est reporté sur le secteur pour ne jamais perdre
                // d'œufs à l'arrondi (45 œufs avec un plateau de 30 = +1 plateau en stock, 15 reportés).
                if (releve.oeufs_collectes > 0) {
                    const secteurOeufsRes = await client.query(
                        `SELECT s.id AS secteur_id, s.produit_oeufs_id, s.oeufs_par_plateau, s.oeufs_non_conditionnes
                         FROM lots_production l JOIN secteurs s ON s.id = l.secteur_id WHERE l.id = $1`,
                        [releve.lot_id]
                    );
                    const secteurOeufs = secteurOeufsRes.rows[0];
                    if (secteurOeufs?.produit_oeufs_id) {
                        const parPlateau = Number(secteurOeufs.oeufs_par_plateau) || 30;
                        const totalOeufs = Number(secteurOeufs.oeufs_non_conditionnes || 0) + Number(releve.oeufs_collectes);
                        const plateauxComplets = Math.floor(totalOeufs / parPlateau);
                        const reste = totalOeufs % parPlateau;
                        if (plateauxComplets > 0) {
                            await client.query(
                                `UPDATE stocks SET quantite_disponible = quantite_disponible + $1, derniere_mise_a_jour = CURRENT_TIMESTAMP WHERE produit_id = $2`,
                                [plateauxComplets, secteurOeufs.produit_oeufs_id]
                            );
                        }
                        await client.query(`UPDATE secteurs SET oeufs_non_conditionnes = $1 WHERE id = $2`, [reste, secteurOeufs.secteur_id]);
                    }
                }
            }

            await client.query('COMMIT');
            await logAudit(req.db, { req, table: 'releves_journaliers', action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { count: releves.length } });
            res.status(200).json({ message: `${releves.length} relevé(s) synchronisé(s) avec succès.` });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error('Erreur de synchronisation:', err);
            res.status(500).json({ erreur: 'Échec de la synchronisation des données de production.' });
        }
    });

    // FCR = aliment consommé (kg) / gain de poids produit (kg) — indicateur clé Avicole/Piscicole
    router.get('/lots/:id/fcr', requireAuth(pool), async (req, res) => {
        try {
            const lot = await req.db.query(`SELECT * FROM lots_production WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.user.tenant_id]);
            if (lot.rows.length === 0) return res.status(404).json({ erreur: 'Lot introuvable.' });
            if (!(await verifierAccesLot(req.db, req.params.id, req.user))) {
                return res.status(403).json({ erreur: 'Ce lot ne relève pas de votre secteur.' });
            }

            const releves = await req.db.query(
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

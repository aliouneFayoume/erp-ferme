const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ESPECES_VALIDES = ['BOVIN', 'OVIN', 'CAPRIN'];
const SEXES_VALIDES = ['M', 'F'];
const STATUTS_ANIMAL = ['VIVANT', 'VENDU', 'ABATTU', 'MORT'];

// Même principe que verifierAccesLot (routes/production.js) : un chef de prod est restreint à son
// propre secteur au sein de son organisation, un animal d'une autre organisation n'est jamais visible.
async function verifierAccesAnimal(db, animalId, user) {
    const animal = await db.query(`SELECT tenant_id, secteur_id FROM animaux WHERE id = $1`, [animalId]);
    if (animal.rows.length === 0) return false;
    if (Number(animal.rows[0].tenant_id) !== Number(user.tenant_id)) return false;
    if (user.role === 'chef_prod' && user.secteur_id) {
        return Number(animal.rows[0].secteur_id) === Number(user.secteur_id);
    }
    return true;
}

module.exports = function elevageRoutes(pool) {
    const router = express.Router();

    // -------------------- Animaux --------------------

    router.get('/animaux', requireAuth(pool), async (req, res) => {
        try {
            const params = [req.user.tenant_id];
            let where = `a.tenant_id = $1 AND a.deleted_at IS NULL`;

            if (req.user.role === 'chef_prod' && req.user.secteur_id) {
                params.push(req.user.secteur_id);
                where += ` AND a.secteur_id = $${params.length}`;
            } else if (req.query.secteur_id) {
                params.push(req.query.secteur_id);
                where += ` AND a.secteur_id = $${params.length}`;
            }

            if (req.query.espece) {
                params.push(req.query.espece);
                where += ` AND a.espece = $${params.length}`;
            }
            if (req.query.mere_id) {
                params.push(req.query.mere_id);
                where += ` AND a.mere_id = $${params.length}`;
            }
            // Par défaut on ne montre que les animaux vivants (liste de travail au quotidien) ;
            // ?statut=TOUS pour l'historique complet.
            if (req.query.statut && req.query.statut !== 'TOUS') {
                params.push(req.query.statut);
                where += ` AND a.statut = $${params.length}`;
            } else if (!req.query.statut) {
                where += ` AND a.statut = 'VIVANT'`;
            }

            const result = await req.db.query(
                `SELECT a.*, s.nom as secteur_nom FROM animaux a
                 JOIN secteurs s ON a.secteur_id = s.id
                 WHERE ${where} ORDER BY a.cree_le DESC`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des animaux.' });
        }
    });

    router.get('/animaux/:id', requireAuth(pool), async (req, res) => {
        try {
            if (!(await verifierAccesAnimal(req.db, req.params.id, req.user))) {
                return res.status(403).json({ erreur: 'Cet animal ne relève pas de votre secteur.' });
            }
            const animal = await req.db.query(
                `SELECT a.*, s.nom as secteur_nom FROM animaux a JOIN secteurs s ON a.secteur_id = s.id WHERE a.id = $1`,
                [req.params.id]
            );
            if (animal.rows.length === 0) return res.status(404).json({ erreur: 'Animal introuvable.' });

            const [mere, petits] = await Promise.all([
                animal.rows[0].mere_id
                    ? req.db.query(`SELECT id, identifiant, espece, sexe FROM animaux WHERE id = $1`, [animal.rows[0].mere_id])
                    : Promise.resolve({ rows: [] }),
                req.db.query(
                    `SELECT id, identifiant, espece, sexe, date_naissance, statut FROM animaux WHERE mere_id = $1 ORDER BY date_naissance`,
                    [req.params.id]
                ),
            ]);

            res.json({ ...animal.rows[0], mere: mere.rows[0] || null, petits: petits.rows });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la récupération de l'animal." });
        }
    });

    router.post('/animaux', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { secteur_id, identifiant, espece, race, sexe, date_naissance, origine, poids_initial_kg, mere_id } = req.body;

        if (!identifiant || !espece || !sexe) {
            return res.status(400).json({ erreur: 'Identifiant, espèce et sexe sont requis.' });
        }
        if (!ESPECES_VALIDES.includes(espece)) return res.status(400).json({ erreur: 'Espèce invalide.' });
        if (!SEXES_VALIDES.includes(sexe)) return res.status(400).json({ erreur: 'Sexe invalide.' });
        if (req.user.role === 'chef_prod' && req.user.secteur_id && Number(secteur_id) !== Number(req.user.secteur_id)) {
            return res.status(403).json({ erreur: 'Vous ne pouvez créer un animal que pour votre secteur.' });
        }

        try {
            const secteurRes = await req.db.query(
                `SELECT id FROM secteurs WHERE id = $1 AND tenant_id = $2 AND suivi_individuel = TRUE`,
                [secteur_id, tenantId]
            );
            if (secteurRes.rows.length === 0) {
                return res.status(400).json({ erreur: "Secteur invalide — un animal doit être rattaché à un sous-secteur d'élevage (Bovins/Ovins/Caprins), pas au secteur parent." });
            }

            let mereId = null;
            if (mere_id) {
                const mereRes = await req.db.query(
                    `SELECT id FROM animaux WHERE id = $1 AND tenant_id = $2 AND secteur_id = $3 AND espece = $4 AND sexe = 'F' AND statut = 'VIVANT'`,
                    [mere_id, tenantId, secteur_id, espece]
                );
                if (mereRes.rows.length === 0) return res.status(400).json({ erreur: 'Mère invalide (doit être une femelle vivante du même secteur/espèce).' });
                mereId = mere_id;
            }

            const result = await req.db.query(
                `INSERT INTO animaux (tenant_id, secteur_id, identifiant, espece, race, sexe, date_naissance, mere_id, origine, poids_initial_kg, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [tenantId, secteur_id, identifiant, espece, race || null, sexe, date_naissance || null, mereId, origine || 'NE_FERME', poids_initial_kg || null, req.user.id]
            );
            await logAudit(req.db, { req, table: 'animaux', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ erreur: 'Cet identifiant est déjà utilisé.' });
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'animal." });
        }
    });

    router.put('/animaux/:id', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { race, sexe, notes } = req.body;
        if (!(await verifierAccesAnimal(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Cet animal ne relève pas de votre secteur.' });
        }
        if (sexe && !SEXES_VALIDES.includes(sexe)) return res.status(400).json({ erreur: 'Sexe invalide.' });
        try {
            const result = await req.db.query(
                `UPDATE animaux SET race = COALESCE($1, race), sexe = COALESCE($2, sexe), notes = COALESCE($3, notes)
                 WHERE id = $4 AND tenant_id = $5 AND deleted_at IS NULL RETURNING *`,
                [race, sexe, notes, req.params.id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Animal introuvable.' });
            await logAudit(req.db, { req, table: 'animaux', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'animal." });
        }
    });

    router.put('/animaux/:id/statut', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { statut, date_sortie } = req.body;
        if (!STATUTS_ANIMAL.includes(statut)) return res.status(400).json({ erreur: 'Statut invalide.' });
        if (!(await verifierAccesAnimal(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Cet animal ne relève pas de votre secteur.' });
        }
        try {
            const actuel = await req.db.query(`SELECT statut FROM animaux WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [req.params.id, tenantId]);
            if (actuel.rows.length === 0) return res.status(404).json({ erreur: 'Animal introuvable.' });
            if (actuel.rows[0].statut !== 'VIVANT') {
                return res.status(400).json({ erreur: "Cet animal n'est plus vivant, son statut ne peut plus être modifié." });
            }
            const result = await req.db.query(
                `UPDATE animaux SET statut = $1, date_sortie = $2 WHERE id = $3 AND tenant_id = $4 RETURNING *`,
                [statut, date_sortie || new Date().toISOString().slice(0, 10), req.params.id, tenantId]
            );
            await logAudit(req.db, { req, table: 'animaux', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: { statut } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors du changement de statut de l'animal." });
        }
    });

    router.delete('/animaux/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const result = await req.db.query(
            `UPDATE animaux SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Animal introuvable.' });
        await logAudit(req.db, { req, table: 'animaux', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    // -------------------- Relevés (pesée / vaccination / traitement / observation) --------------------

    router.get('/animaux/:id/releves', requireAuth(pool), async (req, res) => {
        if (!(await verifierAccesAnimal(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Cet animal ne relève pas de votre secteur.' });
        }
        const result = await req.db.query(
            `SELECT * FROM releves_animal WHERE animal_id = $1 ORDER BY date_releve DESC, id DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    router.post('/animaux/:id/releves', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const { date_releve, type_evenement, poids_kg, produit_utilise, notes } = req.body;
        const TYPES_VALIDES = ['PESEE', 'VACCINATION', 'TRAITEMENT', 'OBSERVATION'];
        if (!date_releve || !TYPES_VALIDES.includes(type_evenement)) {
            return res.status(400).json({ erreur: 'Date et type de relevé (valide) sont requis.' });
        }
        if (type_evenement === 'PESEE' && (poids_kg === undefined || poids_kg === null || poids_kg === '')) {
            return res.status(400).json({ erreur: 'Le poids est requis pour une pesée.' });
        }
        if (!(await verifierAccesAnimal(req.db, req.params.id, req.user))) {
            return res.status(403).json({ erreur: 'Cet animal ne relève pas de votre secteur.' });
        }
        try {
            const result = await req.db.query(
                `INSERT INTO releves_animal (animal_id, utilisateur_id, date_releve, type_evenement, poids_kg, produit_utilise, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [req.params.id, req.user.id, date_releve, type_evenement, type_evenement === 'PESEE' ? poids_kg : null, produit_utilise || null, notes || null]
            );
            await logAudit(req.db, { req, table: 'releves_animal', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId: req.user.tenant_id, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement du relevé." });
        }
    });

    // -------------------- Reproduction (saillie / mise-bas) --------------------

    router.get('/reproductions', requireAuth(pool), async (req, res) => {
        const params = [req.user.tenant_id];
        let where = `r.tenant_id = $1`;
        if (req.query.mere_id) {
            params.push(req.query.mere_id);
            where += ` AND r.mere_id = $${params.length}`;
        }
        if (req.query.statut) {
            params.push(req.query.statut);
            where += ` AND r.statut = $${params.length}`;
        }
        const result = await req.db.query(
            `SELECT r.*, m.identifiant as mere_identifiant FROM reproductions r
             JOIN animaux m ON m.id = r.mere_id
             WHERE ${where} ORDER BY r.date_saillie DESC`,
            params
        );
        res.json(result.rows);
    });

    router.post('/reproductions', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { mere_id, pere_id, date_saillie, date_mise_bas_prevue, notes } = req.body;
        if (!mere_id || !date_saillie) return res.status(400).json({ erreur: 'Mère et date de saillie sont requises.' });
        if (!(await verifierAccesAnimal(req.db, mere_id, req.user))) {
            return res.status(403).json({ erreur: 'Cette mère ne relève pas de votre secteur.' });
        }
        try {
            const mereRes = await req.db.query(`SELECT sexe, statut, espece FROM animaux WHERE id = $1 AND tenant_id = $2`, [mere_id, tenantId]);
            if (mereRes.rows.length === 0 || mereRes.rows[0].sexe !== 'F' || mereRes.rows[0].statut !== 'VIVANT') {
                return res.status(400).json({ erreur: 'La mère doit être une femelle vivante.' });
            }
            if (pere_id) {
                const pereRes = await req.db.query(`SELECT sexe, statut, espece FROM animaux WHERE id = $1 AND tenant_id = $2`, [pere_id, tenantId]);
                if (pereRes.rows.length === 0 || pereRes.rows[0].sexe !== 'M' || pereRes.rows[0].statut !== 'VIVANT' || pereRes.rows[0].espece !== mereRes.rows[0].espece) {
                    return res.status(400).json({ erreur: 'Le père doit être un mâle vivant de la même espèce.' });
                }
            }
            const enCours = await req.db.query(`SELECT id FROM reproductions WHERE mere_id = $1 AND statut = 'EN_COURS'`, [mere_id]);
            if (enCours.rows.length > 0) {
                return res.status(409).json({ erreur: 'Une gestation est déjà en cours pour cette mère.' });
            }

            const result = await req.db.query(
                `INSERT INTO reproductions (tenant_id, mere_id, pere_id, date_saillie, date_mise_bas_prevue, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [tenantId, mere_id, pere_id || null, date_saillie, date_mise_bas_prevue || null, notes || null, req.user.id]
            );
            await logAudit(req.db, { req, table: 'reproductions', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de la saillie." });
        }
    });

    // Endpoint transactionnel clé : crée tous les petits d'une portée d'un coup, ou aucun (même
    // pattern que routes/paie.js PUT /bulletins/:id/payer). nombre_petits est TOUJOURS dérivé de
    // petits.length, jamais un champ client séparé, pour garantir la cohérence.
    router.put('/reproductions/:id/mise-bas', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { date_mise_bas_reelle, petits } = req.body;
        if (!date_mise_bas_reelle || !Array.isArray(petits) || petits.length === 0) {
            return res.status(400).json({ erreur: 'Date de mise-bas et au moins un petit sont requis.' });
        }
        const client = req.db;
        try {
            await client.query('BEGIN');

            const reproRes = await client.query(
                `SELECT r.*, m.secteur_id, m.espece FROM reproductions r
                 JOIN animaux m ON m.id = r.mere_id
                 WHERE r.id = $1 AND r.tenant_id = $2 FOR UPDATE`,
                [req.params.id, tenantId]
            );
            if (reproRes.rows.length === 0) throw { statut: 404, message: 'Gestation introuvable.' };
            const repro = reproRes.rows[0];
            if (repro.statut !== 'EN_COURS') throw { statut: 400, message: 'Seule une gestation "En cours" peut être clôturée par une mise-bas.' };
            if (req.user.role === 'chef_prod' && req.user.secteur_id && Number(repro.secteur_id) !== Number(req.user.secteur_id)) {
                throw { statut: 403, message: 'Cette gestation ne relève pas de votre secteur.' };
            }

            const nouveaux = [];
            for (const petit of petits) {
                if (!petit.identifiant || !SEXES_VALIDES.includes(petit.sexe)) {
                    throw { statut: 400, message: 'Chaque petit doit avoir un identifiant et un sexe valide.' };
                }
                const inserted = await client.query(
                    `INSERT INTO animaux (tenant_id, secteur_id, identifiant, espece, sexe, date_naissance, mere_id, reproduction_id, origine, poids_initial_kg, cree_par)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NE_FERME', $9, $10) RETURNING *`,
                    [tenantId, repro.secteur_id, petit.identifiant, repro.espece, petit.sexe, date_mise_bas_reelle, repro.mere_id, repro.id, petit.poids_initial_kg || null, req.user.id]
                );
                nouveaux.push(inserted.rows[0]);
            }

            const updated = await client.query(
                `UPDATE reproductions SET statut = 'MISE_BAS', date_mise_bas_reelle = $1, nombre_petits = $2 WHERE id = $3 RETURNING *`,
                [date_mise_bas_reelle, petits.length, repro.id]
            );

            await client.query('COMMIT');
            await logAudit(req.db, { req, table: 'reproductions', rowId: repro.id, action: 'UPDATE', userId: req.user.id, tenantId, details: { statut: 'MISE_BAS', count: petits.length } });
            res.json({ ...updated.rows[0], petits: nouveaux });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            if (err.code === '23505') return res.status(409).json({ erreur: 'Un des identifiants est déjà utilisé — aucun petit créé.' });
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de la mise-bas." });
        }
    });

    router.put('/reproductions/:id/echec', requireAuth(pool), checkRole(['chef_prod']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        try {
            const result = await req.db.query(
                `UPDATE reproductions SET statut = 'ECHEC' WHERE id = $1 AND tenant_id = $2 AND statut = 'EN_COURS' RETURNING *`,
                [req.params.id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Gestation introuvable ou déjà clôturée.' });
            await logAudit(req.db, { req, table: 'reproductions', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: { statut: 'ECHEC' } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la clôture de la gestation.' });
        }
    });

    return router;
};

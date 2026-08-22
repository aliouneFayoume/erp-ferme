const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ROLES_IMMOBILISATION = ['comptable'];
const CATEGORIE_DEPENSE_MATERIEL = 'Machines & Équipements';

/**
 * Valeur nette comptable = valeur d'achat − somme des dotations d'amortissement déjà postées
 * (table `amortissements`), plancher à la valeur résiduelle. Calculé en JS plutôt qu'en SQL/vue
 * matérialisée pour rester portable pg-mem — même choix que le délai fournisseur (fournisseurs.js).
 */
function calculerValeurNetteComptable(equipement, sommeAmortissements) {
    if (equipement.valeur_achat == null) return null;
    const residuelle = Number(equipement.valeur_residuelle) || 0;
    const brut = Number(equipement.valeur_achat) - Number(sommeAmortissements || 0);
    return Math.max(brut, residuelle);
}

module.exports = function immobilisationsRoutes(pool) {
    const router = express.Router();

    // -------------------- Inventaire --------------------

    router.get('/', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const [equipements, amortis] = await Promise.all([
            req.db.query(
                `SELECT e.*, s.nom as secteur_nom, f.nom as fournisseur_nom
                 FROM equipements e
                 LEFT JOIN secteurs s ON s.id = e.secteur_id
                 LEFT JOIN fournisseurs f ON f.id = e.fournisseur_id
                 WHERE e.tenant_id = $1 AND e.deleted_at IS NULL ORDER BY e.nom`,
                [tenantId]
            ),
            req.db.query(
                `SELECT a.equipement_id, COALESCE(SUM(a.montant), 0) as total
                 FROM amortissements a
                 JOIN equipements e ON e.id = a.equipement_id
                 WHERE e.tenant_id = $1 GROUP BY a.equipement_id`,
                [tenantId]
            ),
        ]);
        const sommeParEquipement = Object.fromEntries(amortis.rows.map((r) => [r.equipement_id, r.total]));
        const avecValeurNette = equipements.rows.map((e) => ({
            ...e,
            amortissement_cumule: sommeParEquipement[e.id] || 0,
            valeur_nette_comptable: calculerValeurNetteComptable(e, sommeParEquipement[e.id]),
        }));
        res.json(avecValeurNette);
    });

    router.post('/', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const {
            nom, categorie, secteur_id, fournisseur_id, etat, quantite,
            date_achat, valeur_achat, duree_amortissement_mois, valeur_residuelle, notes,
        } = req.body;
        if (!nom) return res.status(400).json({ erreur: "Le nom de l'équipement est requis." });
        try {
            const result = await req.db.query(
                `INSERT INTO equipements (tenant_id, nom, categorie, secteur_id, fournisseur_id, etat, quantite,
                    date_achat, valeur_achat, duree_amortissement_mois, valeur_residuelle, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
                [
                    tenantId, nom, categorie || null, secteur_id || null, fournisseur_id || null,
                    etat || 'Bon', quantite || 1, date_achat || null, valeur_achat || null,
                    duree_amortissement_mois || null, valeur_residuelle || 0, notes || null, req.user.id,
                ]
            );
            await logAudit(req.db, { req, table: 'equipements', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'équipement." });
        }
    });

    router.put('/:id', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const {
            nom, categorie, secteur_id, fournisseur_id, etat, quantite,
            date_achat, valeur_achat, duree_amortissement_mois, valeur_residuelle, notes,
        } = req.body;
        try {
            const result = await req.db.query(
                `UPDATE equipements SET
                    nom = COALESCE($1, nom), categorie = COALESCE($2, categorie),
                    secteur_id = COALESCE($3, secteur_id), fournisseur_id = COALESCE($4, fournisseur_id),
                    etat = COALESCE($5, etat), quantite = COALESCE($6, quantite),
                    date_achat = COALESCE($7, date_achat), valeur_achat = COALESCE($8, valeur_achat),
                    duree_amortissement_mois = COALESCE($9, duree_amortissement_mois),
                    valeur_residuelle = COALESCE($10, valeur_residuelle), notes = COALESCE($11, notes)
                 WHERE id = $12 AND tenant_id = $13 AND deleted_at IS NULL RETURNING *`,
                [
                    nom, categorie, secteur_id, fournisseur_id, etat, quantite, date_achat, valeur_achat,
                    duree_amortissement_mois, valeur_residuelle, notes, req.params.id, tenantId,
                ]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
            await logAudit(req.db, { req, table: 'equipements', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'équipement." });
        }
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const result = await req.db.query(
            `UPDATE equipements SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
        await logAudit(req.db, { req, table: 'equipements', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    // -------------------- Entretien --------------------
    // Chaque entretien loggé met à jour equipements.prochain_entretien (dénormalisé pour la liste)
    // et, si un coût est renseigné, génère une dépense — même principe que la réception d'une
    // commande fournisseur (routes/fournisseurs.js /commandes/:id/recevoir).

    router.get('/:id/entretiens', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const equipement = await req.db.query(`SELECT id FROM equipements WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
        if (equipement.rows.length === 0) return res.status(404).json({ erreur: 'Équipement introuvable.' });
        const result = await req.db.query(
            `SELECT * FROM entretiens_equipement WHERE equipement_id = $1 ORDER BY date_entretien DESC, id DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    });

    router.post('/:id/entretiens', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { date_entretien, description, cout, prochain_entretien } = req.body;
        if (!date_entretien) return res.status(400).json({ erreur: "La date de l'entretien est requise." });

        const client = req.db;
        try {
            await client.query('BEGIN');

            const equipementRes = await client.query(
                `SELECT * FROM equipements WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL FOR UPDATE`,
                [req.params.id, tenantId]
            );
            if (equipementRes.rows.length === 0) throw { statut: 404, message: 'Équipement introuvable.' };
            const equipement = equipementRes.rows[0];

            const entretienRes = await client.query(
                `INSERT INTO entretiens_equipement (equipement_id, date_entretien, description, cout, prochain_entretien, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [equipement.id, date_entretien, description || null, cout || null, prochain_entretien || null, req.user.id]
            );

            await client.query(`UPDATE equipements SET prochain_entretien = $1 WHERE id = $2`, [prochain_entretien || null, equipement.id]);

            let depenseId = null;
            if (cout) {
                const depenseRes = await client.query(
                    `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                    [
                        tenantId, equipement.secteur_id, CATEGORIE_DEPENSE_MATERIEL, cout,
                        `Entretien ${equipement.nom}${description ? ` — ${description}` : ''}`, date_entretien, req.user.id,
                    ]
                );
                depenseId = depenseRes.rows[0].id;
            }

            await client.query('COMMIT');
            await logAudit(req.db, {
                req, table: 'entretiens_equipement', rowId: entretienRes.rows[0].id, action: 'CREATE',
                userId: req.user.id, tenantId, details: { equipement_id: equipement.id, cout, depense_id: depenseId },
            });
            res.status(201).json(entretienRes.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de l'entretien." });
        }
    });

    // -------------------- Amortissement --------------------
    // Déclenché manuellement par le comptable (pas de tâche planifiée côté serveur aujourd'hui) —
    // idempotent grâce à UNIQUE (equipement_id, periode) sur `amortissements` : recliquer sur la
    // même période ne double jamais la dépense.

    router.post('/amortissements/calculer', requireAuth(pool), checkRole(ROLES_IMMOBILISATION), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { periode } = req.body; // 'YYYY-MM-DD', normalisé au 1er du mois côté client
        if (!periode) return res.status(400).json({ erreur: 'La période est requise.' });
        const periodeNormalisee = `${periode.slice(0, 7)}-01`;

        const client = req.db;
        let comptabilises = 0;
        try {
            await client.query('BEGIN');

            const equipementsRes = await client.query(
                `SELECT * FROM equipements
                 WHERE tenant_id = $1 AND deleted_at IS NULL AND duree_amortissement_mois IS NOT NULL AND valeur_achat IS NOT NULL`,
                [tenantId]
            );

            for (const equipement of equipementsRes.rows) {
                const dotation = (Number(equipement.valeur_achat) - Number(equipement.valeur_residuelle || 0)) / equipement.duree_amortissement_mois;
                if (!(dotation > 0)) continue;

                // Vérification explicite plutôt que ON CONFLICT ... DO NOTHING RETURNING : pg-mem
                // (tests/dev) renvoie à tort la ligne existante dans RETURNING même quand l'insertion
                // est ignorée par le conflit — un INSERT réel n'a jamais lieu (confirmé), mais s'y fier
                // pour détecter "déjà comptabilisé" casse silencieusement l'idempotence en test.
                const dejaComptabilise = await client.query(
                    `SELECT id FROM amortissements WHERE equipement_id = $1 AND periode = $2`,
                    [equipement.id, periodeNormalisee]
                );
                if (dejaComptabilise.rows.length > 0) continue; // déjà comptabilisé pour cette période

                const insertAmorti = await client.query(
                    `INSERT INTO amortissements (equipement_id, periode, montant, cree_par)
                     VALUES ($1, $2, $3, $4) RETURNING id`,
                    [equipement.id, periodeNormalisee, dotation, req.user.id]
                );

                const depenseRes = await client.query(
                    `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                    [
                        tenantId, equipement.secteur_id, CATEGORIE_DEPENSE_MATERIEL, dotation,
                        `Amortissement ${equipement.nom} — ${periodeNormalisee.slice(0, 7)}`, periodeNormalisee, req.user.id,
                    ]
                );
                await client.query(`UPDATE amortissements SET depense_id = $1 WHERE id = $2`, [depenseRes.rows[0].id, insertAmorti.rows[0].id]);
                comptabilises++;
            }

            await client.query('COMMIT');
            await logAudit(req.db, {
                req, table: 'amortissements', rowId: null, action: 'CREATE',
                userId: req.user.id, tenantId, details: { periode: periodeNormalisee, comptabilises },
            });
            res.json({ periode: periodeNormalisee, comptabilises });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors du calcul des amortissements." });
        }
    });

    return router;
};

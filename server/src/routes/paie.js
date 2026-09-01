const express = require('express');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

const ROLES_PAIE = ['admin', 'comptable'];

module.exports = function paieRoutes(pool) {
    const router = express.Router();

    // -------------------- Employés --------------------

    router.get('/employes', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const result = await req.db.query(
            `SELECT e.*, s.nom as secteur_nom FROM employes e
             LEFT JOIN secteurs s ON s.id = e.secteur_id
             WHERE e.tenant_id = $1 AND e.deleted_at IS NULL ORDER BY e.actif DESC, e.nom_complet`,
            [req.user.tenant_id]
        );
        res.json(result.rows);
    });

    router.post('/employes', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom_complet, poste, secteur_id, telephone, date_embauche, salaire_brut_mensuel, type_contrat, taux_journalier, notes } = req.body;
        if (!nom_complet) return res.status(400).json({ erreur: "Le nom de l'employé est requis." });
        const typeContratNormalise = type_contrat === 'JOURNALIER' ? 'JOURNALIER' : 'MENSUEL';
        if (typeContratNormalise === 'JOURNALIER' && !(Number(taux_journalier) > 0)) {
            return res.status(400).json({ erreur: 'Le taux journalier est requis pour un journalier.' });
        }
        try {
            const result = await req.db.query(
                `INSERT INTO employes (tenant_id, nom_complet, poste, secteur_id, telephone, date_embauche, salaire_brut_mensuel, type_contrat, taux_journalier, notes, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
                [
                    tenantId, nom_complet, poste || null, secteur_id || null, telephone || null,
                    date_embauche || null, salaire_brut_mensuel || null, typeContratNormalise,
                    typeContratNormalise === 'JOURNALIER' ? Number(taux_journalier) : null, notes || null, req.user.id,
                ]
            );
            await logAudit(req.db, { req, table: 'employes', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de l'employé." });
        }
    });

    router.put('/employes/:id', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { nom_complet, poste, secteur_id, telephone, date_embauche, date_depart, salaire_brut_mensuel, type_contrat, taux_journalier, actif, notes } = req.body;
        if (type_contrat === 'JOURNALIER' && taux_journalier != null && !(Number(taux_journalier) > 0)) {
            return res.status(400).json({ erreur: 'Le taux journalier doit être supérieur à zéro.' });
        }
        try {
            const result = await req.db.query(
                `UPDATE employes SET
                    nom_complet = COALESCE($1, nom_complet), poste = COALESCE($2, poste),
                    secteur_id = COALESCE($3, secteur_id), telephone = COALESCE($4, telephone),
                    date_embauche = COALESCE($5, date_embauche), date_depart = COALESCE($6, date_depart),
                    salaire_brut_mensuel = COALESCE($7, salaire_brut_mensuel),
                    type_contrat = COALESCE($8, type_contrat), taux_journalier = COALESCE($9, taux_journalier),
                    actif = COALESCE($10, actif), notes = COALESCE($11, notes)
                 WHERE id = $12 AND tenant_id = $13 AND deleted_at IS NULL RETURNING *`,
                [nom_complet, poste, secteur_id, telephone, date_embauche, date_depart, salaire_brut_mensuel, type_contrat || null, taux_journalier || null, actif, notes, req.params.id, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Employé introuvable.' });
            await logAudit(req.db, { req, table: 'employes', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'employé." });
        }
    });

    router.delete('/employes/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const result = await req.db.query(
            `UPDATE employes SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, tenantId]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Employé introuvable.' });
        await logAudit(req.db, { req, table: 'employes', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId });
        res.status(204).end();
    });

    // -------------------- Bulletins de paie --------------------
    // Le coût réellement posté en dépense au passage "Payé" = salaire_brut + charges_sociales (coût
    // employeur total), pas le salaire net — voir migration-18. Même pattern que
    // routes/immobilisations.js (entretien) et routes/fournisseurs.js (réception de commande) :
    // création "en attente" séparée de l'action qui poste réellement la dépense.

    router.get('/bulletins', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { periode } = req.query;
        const conditions = [`emp.tenant_id = $1`];
        const params = [tenantId];
        if (periode) {
            conditions.push(`bp.periode = $2`);
            params.push(`${String(periode).slice(0, 7)}-01`);
        }
        const result = await req.db.query(
            `SELECT bp.*, emp.nom_complet, emp.poste
             FROM bulletins_paie bp
             JOIN employes emp ON emp.id = bp.employe_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY bp.periode DESC, emp.nom_complet`,
            params
        );
        res.json(result.rows);
    });

    router.post('/bulletins', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { employe_id, periode, salaire_brut, charges_sociales } = req.body;
        if (!employe_id || !periode || salaire_brut == null) {
            return res.status(400).json({ erreur: 'Employé, période et salaire brut sont requis.' });
        }
        const periodeNormalisee = `${String(periode).slice(0, 7)}-01`;
        const charges = Number(charges_sociales) || 0;
        const salaireNet = Number(salaire_brut) - charges;
        try {
            const employeRes = await req.db.query(`SELECT id FROM employes WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [employe_id, tenantId]);
            if (employeRes.rows.length === 0) return res.status(400).json({ erreur: 'Employé invalide.' });

            const result = await req.db.query(
                `INSERT INTO bulletins_paie (employe_id, periode, salaire_brut, charges_sociales, salaire_net, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [employe_id, periodeNormalisee, salaire_brut, charges, salaireNet, req.user.id]
            );
            await logAudit(req.db, { req, table: 'bulletins_paie', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: req.body });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ erreur: 'Un bulletin existe déjà pour cet employé sur cette période.' });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du bulletin.' });
        }
    });

    router.put('/bulletins/:id/payer', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const client = req.db;
        try {
            await client.query('BEGIN');

            const bulletinRes = await client.query(
                `SELECT bp.*, emp.nom_complet, emp.secteur_id, emp.tenant_id
                 FROM bulletins_paie bp JOIN employes emp ON emp.id = bp.employe_id
                 WHERE bp.id = $1 AND emp.tenant_id = $2 FOR UPDATE`,
                [req.params.id, tenantId]
            );
            if (bulletinRes.rows.length === 0) throw { statut: 404, message: 'Bulletin introuvable.' };
            const bulletin = bulletinRes.rows[0];
            if (bulletin.statut !== 'EN_ATTENTE') throw { statut: 400, message: 'Seul un bulletin "En attente" peut être marqué payé.' };

            const aujourdhui = new Date().toISOString().slice(0, 10);
            const coutTotal = Number(bulletin.salaire_brut) + Number(bulletin.charges_sociales);
            const depenseRes = await client.query(
                `INSERT INTO depenses (tenant_id, secteur_id, categorie, montant, description, date_depense, cree_par)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [
                    tenantId, bulletin.secteur_id, "Main d'œuvre", coutTotal,
                    `Paie ${bulletin.nom_complet} — ${bulletin.periode.toISOString ? bulletin.periode.toISOString().slice(0, 7) : String(bulletin.periode).slice(0, 7)}`,
                    aujourdhui, req.user.id,
                ]
            );

            const updated = await client.query(
                `UPDATE bulletins_paie SET statut = 'PAYE', date_paiement = $1, depense_id = $2 WHERE id = $3 RETURNING *`,
                [aujourdhui, depenseRes.rows[0].id, bulletin.id]
            );

            await client.query('COMMIT');
            await logAudit(req.db, {
                req, table: 'bulletins_paie', rowId: bulletin.id, action: 'UPDATE',
                userId: req.user.id, tenantId, details: { statut: 'PAYE', depense_id: depenseRes.rows[0].id },
            });
            res.json(updated.rows[0]);
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du paiement du bulletin.' });
        }
    });

    // -------------------- Pointages des journaliers --------------------
    // Une ligne dans pointages_journaliers = un jour travaillé (absence de ligne = absent, voir
    // migration-21). Le calcul jours_travailles x taux_journalier pour le bulletin de paie se fait
    // côté frontend, à partir de /pointages/recapitulatif — bulletins_paie reste inchangé.

    router.get('/pointages', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const date = String(req.query.date || '').slice(0, 10);
        if (!date) return res.status(400).json({ erreur: 'La date est requise.' });
        const result = await req.db.query(
            `SELECT e.id AS employe_id, e.nom_complet, e.poste, (p.id IS NOT NULL) AS pointe
             FROM employes e
             LEFT JOIN pointages_journaliers p ON p.employe_id = e.id AND p.date_pointage = $2
             WHERE e.tenant_id = $1 AND e.type_contrat = 'JOURNALIER' AND e.actif AND e.deleted_at IS NULL
             ORDER BY e.nom_complet`,
            [tenantId, date]
        );
        res.json(result.rows);
    });

    router.post('/pointages/toggle', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const { employe_id, date } = req.body;
        const dateNormalisee = String(date || '').slice(0, 10);
        if (!employe_id || !dateNormalisee) return res.status(400).json({ erreur: 'Employé et date sont requis.' });
        try {
            const employeRes = await req.db.query(
                `SELECT id FROM employes WHERE id = $1 AND tenant_id = $2 AND type_contrat = 'JOURNALIER' AND deleted_at IS NULL`,
                [employe_id, tenantId]
            );
            if (employeRes.rows.length === 0) return res.status(400).json({ erreur: 'Journalier invalide.' });

            const existant = await req.db.query(
                `SELECT id FROM pointages_journaliers WHERE employe_id = $1 AND date_pointage = $2`,
                [employe_id, dateNormalisee]
            );
            let pointe;
            if (existant.rows.length > 0) {
                await req.db.query(`DELETE FROM pointages_journaliers WHERE id = $1`, [existant.rows[0].id]);
                pointe = false;
            } else {
                await req.db.query(
                    `INSERT INTO pointages_journaliers (employe_id, date_pointage, cree_par) VALUES ($1, $2, $3)`,
                    [employe_id, dateNormalisee, req.user.id]
                );
                pointe = true;
            }
            await logAudit(req.db, { req, table: 'pointages_journaliers', rowId: employe_id, action: 'UPDATE', userId: req.user.id, tenantId, details: { date: dateNormalisee, pointe } });
            res.json({ pointe });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du pointage.' });
        }
    });

    router.get('/pointages/recapitulatif', requireAuth(pool), checkRole(ROLES_PAIE), async (req, res) => {
        const tenantId = req.user.tenant_id;
        const periode = String(req.query.periode || '').slice(0, 7);
        if (!periode) return res.status(400).json({ erreur: 'La période est requise.' });
        const debutPeriode = `${periode}-01`;
        const [annee, mois] = periode.split('-').map(Number);
        const finPeriode = mois === 12 ? `${annee + 1}-01-01` : `${annee}-${String(mois + 1).padStart(2, '0')}-01`;
        // Bornes explicites plutôt que to_char/date_trunc : évite une dépendance à des fonctions
        // date non fiablement supportées par pg-mem (voir tests) tout en restant correct sur Postgres.
        const result = await req.db.query(
            `SELECT e.id AS employe_id, COUNT(p.id)::int AS jours_travailles
             FROM employes e
             LEFT JOIN pointages_journaliers p
                ON p.employe_id = e.id AND p.date_pointage >= $2::date AND p.date_pointage < $3::date
             WHERE e.tenant_id = $1 AND e.type_contrat = 'JOURNALIER' AND e.actif AND e.deleted_at IS NULL
             GROUP BY e.id`,
            [tenantId, debutPeriode, finPeriode]
        );
        res.json(result.rows);
    });

    return router;
};

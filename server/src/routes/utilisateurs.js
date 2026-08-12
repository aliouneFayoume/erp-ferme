const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAuth, checkRole } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function utilisateursRoutes(pool) {
    const router = express.Router();

    // Liste complète (actifs + inactifs) pour la gestion admin ; les écrans qui n'ont besoin que des
    // comptes actifs (ex: assignation d'une livraison à un livreur) filtrent `actif` côté front.
    router.get('/', requireAuth(pool), checkRole(['admin', 'comptable']), async (req, res) => {
        const { role } = req.query;
        const params = [req.user.tenant_id];
        let where = `u.tenant_id = $1 AND u.deleted_at IS NULL`;
        if (role) {
            params.push(role);
            where += ` AND r.nom = $${params.length}`;
        }
        const result = await req.db.query(
            `SELECT u.id, u.nom_complet, u.email, u.secteur_id, u.actif, u.cree_le, r.nom as role
             FROM utilisateurs u JOIN roles r ON u.role_id = r.id
             WHERE ${where} ORDER BY u.nom_complet`,
            params
        );
        res.json(result.rows);
    });

    router.get('/roles', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const result = await req.db.query(`SELECT * FROM roles ORDER BY id`);
        res.json(result.rows);
    });

    router.post('/', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { nom_complet, email, password, role, secteur_id } = req.body;
        if (!nom_complet || !email || !password || !role) {
            return res.status(400).json({ erreur: 'Nom, email, mot de passe et rôle sont requis.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ erreur: 'Le mot de passe doit contenir au moins 8 caractères.' });
        }
        try {
            const roleRes = await req.db.query(`SELECT id FROM roles WHERE nom = $1`, [role]);
            if (roleRes.rows.length === 0) return res.status(400).json({ erreur: 'Rôle invalide.' });

            const hash = await bcrypt.hash(password, 10);
            const result = await req.db.query(
                `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, secteur_id, actif)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id, nom_complet, email, secteur_id, actif, cree_le`,
                [req.user.tenant_id, nom_complet, email, hash, roleRes.rows[0].id, role === 'chef_prod' ? secteur_id || null : null]
            );
            await logAudit(req.db, { req,
                table: 'utilisateurs',
                rowId: result.rows[0].id,
                action: 'CREATE',
                userId: req.user.id,
                tenantId: req.user.tenant_id,
                details: { nom_complet, email, role, secteur_id },
            });
            res.status(201).json({ ...result.rows[0], role });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création (email déjà utilisé ?).' });
        }
    });

    router.put('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { nom_complet, email, role, secteur_id, actif } = req.body;
        try {
            let roleId = null;
            if (role) {
                const roleRes = await req.db.query(`SELECT id FROM roles WHERE nom = $1`, [role]);
                if (roleRes.rows.length === 0) return res.status(400).json({ erreur: 'Rôle invalide.' });
                roleId = roleRes.rows[0].id;
            }

            // Un admin ne peut pas se désactiver lui-même : ça pourrait verrouiller l'accès admin.
            if (actif === false && Number(req.params.id) === req.user.id) {
                return res.status(400).json({ erreur: 'Vous ne pouvez pas désactiver votre propre compte.' });
            }

            // token_version + 1 sur toute modification (rôle, secteur, statut actif, ou simple
            // correction du nom/email) : force la reconnexion des sessions déjà ouvertes pour ce
            // compte plutôt que de risquer un JWT encore valide 12h avec un rôle ou un secteur
            // périmés — audit sécurité 2026-08-11 (E2, et son corollaire F5 sur secteur_id figé
            // dans le token). Coût acceptable : cette route n'est appelée que par un admin, rarement.
            const result = await req.db.query(
                `UPDATE utilisateurs SET
                    nom_complet = COALESCE($1, nom_complet),
                    email = COALESCE($2, email),
                    role_id = COALESCE($3, role_id),
                    secteur_id = $4,
                    actif = COALESCE($5, actif),
                    token_version = token_version + 1
                 WHERE id = $6 AND tenant_id = $7 AND deleted_at IS NULL
                 RETURNING id, nom_complet, email, secteur_id, actif`,
                [nom_complet || null, email || null, roleId, role === 'chef_prod' ? secteur_id || null : null, actif, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { nom_complet, email, role, secteur_id, actif } });
            res.json({ ...result.rows[0], role });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour (email déjà utilisé ?).' });
        }
    });

    router.put('/:id/mot-de-passe', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        const { password } = req.body;
        if (!password || password.length < 8) {
            return res.status(400).json({ erreur: 'Le mot de passe doit contenir au moins 8 caractères.' });
        }
        try {
            const hash = await bcrypt.hash(password, 10);
            // token_version + 1 : un changement de mot de passe doit invalider toute session déjà
            // ouverte pour ce compte, y compris un jeton volé qui n'a pas encore expiré (jusqu'à
            // 12h sinon) — audit sécurité 2026-08-11 (E2).
            const result = await req.db.query(
                `UPDATE utilisateurs SET mot_de_passe_hash = $1, token_version = token_version + 1
                 WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL RETURNING id`,
                [hash, req.params.id, req.user.tenant_id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
            // Ne jamais journaliser le mot de passe, même haché : seule l'action est tracée.
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { motDePasseModifie: true } });
            res.json({ message: 'Mot de passe mis à jour.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du changement de mot de passe.' });
        }
    });

    router.delete('/:id', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        if (Number(req.params.id) === req.user.id) {
            return res.status(400).json({ erreur: 'Vous ne pouvez pas supprimer votre propre compte.' });
        }
        // token_version + 1 : redondant avec actif = FALSE (déjà vérifié par requireAuth) mais
        // garde le même réflexe sur toute mutation sensible du compte — défense en profondeur.
        const result = await req.db.query(
            `UPDATE utilisateurs SET deleted_at = CURRENT_TIMESTAMP, actif = FALSE, token_version = token_version + 1
             WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING id`,
            [req.params.id, req.user.tenant_id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });
        await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: req.user.tenant_id });
        res.status(204).end();
    });

    return router;
};

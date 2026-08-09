const express = require('express');
const { requireAuth, requireSuperviseurPlateforme, signToken } = require('../auth');
const { logAudit } = require('../audit');

/**
 * Vue plateforme (support/vente multi-fermes) : réservée à un seul compte (voir
 * migration-04-superviseur-plateforme.sql), en LECTURE SEULE sur les données des autres
 * organisations — voir les policies RLS dédiées dans rls-policies.sql (is_plateforme_admin()) et
 * le commentaire de requireSuperviseurPlateforme dans auth.js. La seule action qui produit un effet
 * cross-tenant est /se-connecter-admin, qui n'écrit rien dans une autre organisation : elle émet un
 * token normal, tenant-scopé, pour un compte qui existe déjà — l'écriture qui suit se fait ensuite
 * dans le contexte normal de CETTE organisation, comme n'importe quelle session admin.
 */
module.exports = function plateformeRoutes(pool) {
    const router = express.Router();
    const garde = [requireAuth(pool), requireSuperviseurPlateforme];

    router.get('/organisations', ...garde, async (req, res) => {
        try {
            // Comptage en JS plutôt qu'en SQL agrégé : les sous-requêtes corrélées dans le SELECT ET
            // COUNT(DISTINCT CASE WHEN ...) font toutes les deux planter pg-mem (voir memory
            // pg-mem-limitations — la seconde est un bug reconnu par pg-mem lui-même, pas juste une
            // fonctionnalité manquante). Volumes concernés (nombre de fermes, de tickets) restent
            // largement dans une fourchette où trois requêtes à plat + un tally JS sont insignifiants.
            const [orgsRes, ticketsRes, usersRes] = await Promise.all([
                req.db.query(`SELECT id, nom, cree_le FROM organisations ORDER BY cree_le DESC`),
                req.db.query(`SELECT tenant_id, statut FROM tickets WHERE deleted_at IS NULL`),
                req.db.query(`SELECT tenant_id FROM utilisateurs WHERE actif = TRUE AND deleted_at IS NULL`),
            ]);

            const ticketsParOrg = new Map();
            for (const t of ticketsRes.rows) {
                const e = ticketsParOrg.get(t.tenant_id) || { ouverts: 0, total: 0 };
                e.total += 1;
                if (t.statut === 'OUVERT' || t.statut === 'EN_COURS') e.ouverts += 1;
                ticketsParOrg.set(t.tenant_id, e);
            }
            const usersParOrg = new Map();
            for (const u of usersRes.rows) {
                usersParOrg.set(u.tenant_id, (usersParOrg.get(u.tenant_id) || 0) + 1);
            }

            res.json(
                orgsRes.rows.map((o) => ({
                    ...o,
                    tickets_ouverts: ticketsParOrg.get(o.id)?.ouverts || 0,
                    tickets_total: ticketsParOrg.get(o.id)?.total || 0,
                    utilisateurs_actifs: usersParOrg.get(o.id) || 0,
                }))
            );
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des organisations.' });
        }
    });

    router.get('/tickets', ...garde, async (req, res) => {
        try {
            const { statut } = req.query;
            const params = [];
            let where = 't.deleted_at IS NULL';
            if (statut) {
                params.push(statut);
                where += ` AND t.statut = $${params.length}`;
            }
            const result = await req.db.query(
                `SELECT t.*, o.nom as organisation_nom, cl.nom as client_nom
                 FROM tickets t
                 JOIN organisations o ON t.tenant_id = o.id
                 LEFT JOIN clients cl ON t.client_id = cl.id
                 WHERE ${where}
                 ORDER BY CASE t.statut WHEN 'OUVERT' THEN 0 WHEN 'EN_COURS' THEN 1 ELSE 2 END,
                          CASE t.priorite WHEN 'URGENTE' THEN 0 WHEN 'HAUTE' THEN 1 WHEN 'NORMALE' THEN 2 ELSE 3 END,
                          t.cree_le DESC
                 LIMIT 300`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des tickets.' });
        }
    });

    router.get('/tickets/:id/messages', ...garde, async (req, res) => {
        try {
            const ticketRes = await req.db.query(`SELECT id FROM tickets WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
            if (ticketRes.rows.length === 0) return res.status(404).json({ erreur: 'Ticket introuvable.' });
            const result = await req.db.query(
                `SELECT m.*, COALESCE(u.nom_complet, cl.nom) as auteur_nom,
                        CASE WHEN m.auteur_client_id IS NOT NULL THEN 'client' ELSE 'staff' END as auteur_type
                 FROM ticket_messages m
                 LEFT JOIN utilisateurs u ON m.utilisateur_id = u.id
                 LEFT JOIN clients cl ON m.auteur_client_id = cl.id
                 WHERE m.ticket_id = $1 ORDER BY m.cree_le ASC`,
                [req.params.id]
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des messages.' });
        }
    });

    /**
     * Émet une session admin normale pour une organisation cible, sans connaître son mot de passe —
     * pour pouvoir répondre à ses tickets ou la dépanner directement, plutôt que rester en lecture
     * seule. Journalisé dans l'audit de LA FERME CIBLE (pas celui de la plateforme) : si le client
     * consulte son propre journal, l'action apparaît clairement comme une connexion support, pas
     * comme une action mystère.
     */
    router.post('/organisations/:id/se-connecter-admin', ...garde, async (req, res) => {
        try {
            const tenantId = req.params.id;
            const adminRes = await req.db.query(
                `SELECT u.id, u.nom_complet, u.email, u.secteur_id, u.tenant_id
                 FROM utilisateurs u JOIN roles r ON u.role_id = r.id
                 WHERE u.tenant_id = $1 AND r.nom = 'admin' AND u.actif = TRUE AND u.deleted_at IS NULL
                 ORDER BY u.id ASC LIMIT 1`,
                [tenantId]
            );
            if (adminRes.rows.length === 0) {
                return res.status(404).json({ erreur: 'Aucun compte administrateur actif pour cette organisation.' });
            }
            const admin = adminRes.rows[0];
            const token = signToken({ ...admin, role_nom: 'admin' });
            await logAudit(req.db, {
                table: 'utilisateurs',
                rowId: admin.id,
                action: 'CONNEXION_SUPPORT',
                userId: req.user.id,
                tenantId: admin.tenant_id,
                details: { superviseur: req.user.nom, cible: admin.email },
            });
            res.json({
                token,
                utilisateur: {
                    id: admin.id,
                    nom_complet: admin.nom_complet,
                    email: admin.email,
                    role: 'admin',
                    secteur_id: admin.secteur_id,
                    tenant_id: admin.tenant_id,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion support.' });
        }
    });

    return router;
};

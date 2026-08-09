const express = require('express');
const { requireAuth, requireSuperviseurPlateforme, signToken } = require('../auth');
const { logAudit } = require('../audit');
const { SOCLE_ESSENTIEL, MODULES_SAAS, PACK_TOUT_COMPRIS, FRAIS_CONFIGURATION_DEFAUT } = require('../modulesSaas');
const { creerNouvelleFerme } = require('../creerFerme');

function dansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

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

    /**
     * Création directe d'une ferme depuis la vue plateforme — même logique que l'inscription
     * self-service (routes/inscription.js), sans code d'invitation puisque l'appelant est déjà
     * authentifié comme superviseur. Pratique quand Alioune configure lui-même un nouveau client au
     * téléphone plutôt que de lui faire remplir le formulaire public.
     */
    router.post('/organisations', ...garde, async (req, res) => {
        try {
            const { nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword } = req.body;
            const { tenantId, admin, nomFerme: nomFermeCree } = await creerNouvelleFerme(pool, {
                nomFerme,
                secteurs,
                adminNomComplet,
                adminEmail,
                adminPassword,
                auditUserId: req.user.id,
            });
            res.status(201).json({ tenantId, admin: { id: admin.id, nom_complet: admin.nom_complet, email: admin.email, organisation_nom: nomFermeCree } });
        } catch (err) {
            if (err.statut) return res.status(err.statut).json({ erreur: err.message });
            if (err.code === '23505') {
                if (err.constraint === 'organisations_slug_key') {
                    return res.status(409).json({ erreur: 'Ce nom de ferme est déjà utilisé, réessayez.' });
                }
                return res.status(409).json({ erreur: 'Cette adresse email est déjà utilisée.' });
            }
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création de la ferme.' });
        }
    });

    router.get('/organisations', ...garde, async (req, res) => {
        try {
            // Comptage en JS plutôt qu'en SQL agrégé : les sous-requêtes corrélées dans le SELECT ET
            // COUNT(DISTINCT CASE WHEN ...) font toutes les deux planter pg-mem (voir memory
            // pg-mem-limitations — la seconde est un bug reconnu par pg-mem lui-même, pas juste une
            // fonctionnalité manquante). Volumes concernés (nombre de fermes, de tickets) restent
            // largement dans une fourchette où trois requêtes à plat + un tally JS sont insignifiants.
            const [orgsRes, ticketsRes, usersRes] = await Promise.all([
                req.db.query(`SELECT id, nom, slug, cree_le FROM organisations WHERE deleted_at IS NULL ORDER BY cree_le DESC`),
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

    /**
     * Suppression (soft delete) d'une ferme qui n'est plus cliente : marque deleted_at, ce qui la
     * fait disparaître de cette liste et bloque immédiatement l'accès de tout son personnel
     * (requireAuth, auth.js) — sans jamais toucher à ses données historiques, même logique que le
     * reste du schéma (deleted_at partout, aucune suppression physique). Réversible en base au besoin
     * (pas de bouton "restaurer" pour l'instant, non demandé).
     */
    router.delete('/organisations/:id', ...garde, async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            if (tenantId === req.user.tenant_id) {
                return res.status(400).json({ erreur: 'Impossible de supprimer votre propre organisation.' });
            }
            const result = await req.db.query(
                `UPDATE organisations SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
                [tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Organisation introuvable.' });
            await logAudit(req.db, { table: 'organisations', rowId: tenantId, action: 'DELETE', userId: req.user.id, tenantId, details: { superviseur: req.user.nom } });
            res.status(204).end();
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la suppression de la ferme.' });
        }
    });

    /**
     * Modifie le sous-domaine (<slug>.massla.sn, voir routes/public.js) d'une ferme — généré
     * automatiquement à la création (creerFerme.js), mais ajustable ici si le nom auto-dérivé ne
     * convient pas. Format volontairement strict (DNS-safe) : minuscules, chiffres, tirets, jamais
     * en début/fin.
     */
    router.put('/organisations/:id/slug', ...garde, async (req, res) => {
        try {
            const tenantId = Number(req.params.id);
            const slug = String(req.body.slug || '').trim().toLowerCase();
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 63) {
                return res.status(400).json({ erreur: 'Sous-domaine invalide (minuscules, chiffres et tirets uniquement, sans tiret en début/fin).' });
            }
            const result = await req.db.query(
                `UPDATE organisations SET slug = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id, slug`,
                [slug, tenantId]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Organisation introuvable.' });
            await logAudit(req.db, { table: 'organisations', rowId: tenantId, action: 'UPDATE', userId: req.user.id, tenantId, details: { slug } });
            res.json(result.rows[0]);
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ erreur: 'Ce sous-domaine est déjà utilisé par une autre ferme.' });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour du sous-domaine.' });
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
                `SELECT u.id, u.nom_complet, u.email, u.secteur_id, u.tenant_id, o.nom as organisation_nom
                 FROM utilisateurs u JOIN roles r ON u.role_id = r.id JOIN organisations o ON u.tenant_id = o.id
                 WHERE u.tenant_id = $1 AND r.nom = 'admin' AND u.actif = TRUE AND u.deleted_at IS NULL
                 ORDER BY u.id ASC LIMIT 1`,
                [tenantId]
            );
            if (adminRes.rows.length === 0) {
                return res.status(404).json({ erreur: 'Aucun compte administrateur actif pour cette organisation.' });
            }
            const admin = adminRes.rows[0];
            // Marqueur d'impersonation : distingue ce token d'une session normale pour que requireAuth
            // (auth.js) laisse passer même si l'abonnement SaaS de cette ferme est suspendu — le
            // superviseur doit pouvoir se connecter à une ferme bloquée pour la dépanner ou la
            // réactiver. Voir la vérification "actif" dans requireAuth.
            const token = signToken({ ...admin, role_nom: 'admin' }, { viaImpersonation: true });
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
                    organisation_nom: admin.organisation_nom,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion support.' });
        }
    });

    router.get('/modules-saas', ...garde, async (req, res) => {
        res.json({ socleEssentiel: SOCLE_ESSENTIEL, modules: MODULES_SAAS, packToutCompris: PACK_TOUT_COMPRIS, fraisConfigurationDefaut: FRAIS_CONFIGURATION_DEFAUT });
    });

    router.get('/organisations/:id/abonnement-saas', ...garde, async (req, res) => {
        try {
            const result = await req.db.query(`SELECT * FROM organisation_abonnement_saas WHERE tenant_id = $1`, [req.params.id]);
            res.json(result.rows[0] || null);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la récupération de l'abonnement." });
        }
    });

    /**
     * Crée ou met à jour l'abonnement SaaS d'une organisation. À la toute première configuration
     * (aucune ligne existante), génère automatiquement la facture de configuration si un montant est
     * fourni — les mises à jour suivantes (changement de modules, de montant négocié) ne la
     * régénèrent jamais, voir frais_configuration_facture.
     */
    router.put('/organisations/:id/abonnement-saas', ...garde, async (req, res) => {
        try {
            const tenantId = req.params.id;
            const { modulesActifs, montantMensuel, fraisConfiguration, actif } = req.body;
            if (!Array.isArray(modulesActifs) || !(Number(montantMensuel) > 0)) {
                return res.status(400).json({ erreur: 'Modules actifs et montant mensuel (positif) sont requis.' });
            }

            const existant = await req.db.query(`SELECT tenant_id, frais_configuration_facture FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenantId]);

            let result;
            if (existant.rows.length === 0) {
                result = await req.db.query(
                    `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, frais_configuration, actif)
                     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
                    [tenantId, modulesActifs, montantMensuel, fraisConfiguration || null, actif !== false]
                );
                if (Number(fraisConfiguration) > 0) {
                    await req.db.query(
                        `INSERT INTO factures_saas (tenant_id, type, montant, date_echeance) VALUES ($1, 'CONFIGURATION', $2, $3)`,
                        [tenantId, fraisConfiguration, dansNJours(7)]
                    );
                    result = await req.db.query(
                        `UPDATE organisation_abonnement_saas SET frais_configuration_facture = TRUE WHERE tenant_id = $1 RETURNING *`,
                        [tenantId]
                    );
                }
            } else {
                result = await req.db.query(
                    `UPDATE organisation_abonnement_saas SET modules_actifs = $1, montant_mensuel = $2, actif = $3 WHERE tenant_id = $4 RETURNING *`,
                    [modulesActifs, montantMensuel, actif !== false, tenantId]
                );
            }

            await logAudit(req.db, { table: 'organisation_abonnement_saas', rowId: tenantId, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'enregistrement de l'abonnement." });
        }
    });

    router.get('/factures-saas', ...garde, async (req, res) => {
        try {
            const { statut } = req.query;
            const params = [];
            let where = '1=1';
            if (statut) {
                params.push(statut);
                where += ` AND f.statut = $${params.length}`;
            }
            const result = await req.db.query(
                `SELECT f.*, o.nom as organisation_nom
                 FROM factures_saas f JOIN organisations o ON f.tenant_id = o.id
                 WHERE ${where}
                 ORDER BY CASE f.statut WHEN 'A_PAYER' THEN 0 WHEN 'EN_RETARD' THEN 0 ELSE 1 END, f.date_echeance ASC`,
                params
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des factures.' });
        }
    });

    /**
     * Génère les échéances d'abonnement du mois courant pour chaque organisation active — idempotent
     * (une organisation déjà facturée pour cette période n'est jamais dupliquée), même logique que
     * /abonnements/generer-commandes (paniers récurrents) : déclenché manuellement, pas de tâche
     * planifiée dédiée dans ce projet.
     */
    router.post('/factures-saas/generer', ...garde, async (req, res) => {
        try {
            const periode = new Date().toISOString().slice(0, 7);
            const abonnements = await req.db.query(`SELECT tenant_id, montant_mensuel FROM organisation_abonnement_saas WHERE actif = TRUE`);

            const resultats = { creees: 0, deja_generees: 0 };
            for (const ab of abonnements.rows) {
                const dejaGeneree = await req.db.query(
                    `SELECT id FROM factures_saas WHERE tenant_id = $1 AND type = 'ABONNEMENT' AND periode = $2`,
                    [ab.tenant_id, periode]
                );
                if (dejaGeneree.rows.length > 0) {
                    resultats.deja_generees += 1;
                    continue;
                }
                await req.db.query(
                    `INSERT INTO factures_saas (tenant_id, type, periode, montant, date_echeance) VALUES ($1, 'ABONNEMENT', $2, $3, $4)`,
                    [ab.tenant_id, periode, ab.montant_mensuel, dansNJours(7)]
                );
                resultats.creees += 1;
            }

            await logAudit(req.db, { table: 'factures_saas', action: 'CREATE', userId: req.user.id, tenantId: null, details: { periode, ...resultats } });
            res.json({ periode, ...resultats });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la génération des factures.' });
        }
    });

    router.put('/factures-saas/:id', ...garde, async (req, res) => {
        try {
            const { statut, methodePaiement, notes } = req.body;
            const statutsValides = ['A_PAYER', 'PAYEE', 'EN_RETARD', 'ANNULEE'];
            if (statut && !statutsValides.includes(statut)) {
                return res.status(400).json({ erreur: 'Statut invalide.' });
            }
            const result = await req.db.query(
                `UPDATE factures_saas SET
                    statut = COALESCE($1, statut),
                    methode_paiement = COALESCE($2, methode_paiement),
                    notes = COALESCE($3, notes),
                    date_paiement = CASE WHEN $1 = 'PAYEE' THEN CURRENT_TIMESTAMP ELSE date_paiement END
                 WHERE id = $4 RETURNING *`,
                [statut || null, methodePaiement || null, notes || null, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Facture introuvable.' });
            await logAudit(req.db, { table: 'factures_saas', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: result.rows[0].tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour de la facture.' });
        }
    });

    return router;
};

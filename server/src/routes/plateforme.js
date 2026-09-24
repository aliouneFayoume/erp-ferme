const express = require('express');
const { requireAuth, requireSuperviseurPlateforme, signToken } = require('../auth');
const { logAudit } = require('../audit');
const { SOCLE_ESSENTIEL, MODULES_SAAS, PACK_TOUT_COMPRIS, FRAIS_CONFIGURATION_DEFAUT } = require('../modulesSaas');
const { creerNouvelleFerme } = require('../creerFerme');
const { envoyerMessageWhatsapp } = require('../whatsapp');
const { envoyerEmailRappelSaas } = require('../email');
const { nomSecteurValide } = require('../validation');
const { getPaydunyaConfig } = require('../paymentConfig');
const { creerJeton, chargerFactureSaas, verifierFacturePayable, erreurHttp } = require('../paiementsSaas');

// Activité d'une ferme (GET /activite) : "saisie" = écriture métier journalisée. Sont exclues les
// tables de configuration et de gestion des comptes, sinon créer un utilisateur ou régler WhatsApp
// ferait passer une ferme pour "active" alors qu'elle n'utilise pas encore l'outil.
const ACTIONS_SAISIE = ['CREATE', 'UPDATE', 'DELETE'];
const TABLES_HORS_SAISIE = new Set([
    'utilisateurs',
    'organisations',
    'secteurs',
    'organisation_whatsapp_config',
    'organisation_paydunya_config',
    'organisation_abonnement_saas',
    // Facturation SaaS : générée par Massla depuis Support plateforme, mais journalisée dans le journal
    // de la ferme facturée — ce n'est pas une saisie du client.
    'factures_saas',
    'paiements_saas',
]);
const JOUR_MS = 24 * 3600 * 1000;

// Délai de paiement d'une facture SaaS (mise en route et abonnement mensuel), en jours après sa génération.
// Aligné sur les conditions de la phase test réseau ANIDA (« payable sous 15 jours ») ; 7 jours était
// court pour de petites fermes.
const DELAI_PAIEMENT_JOURS = 15;

function dansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
}

/**
 * Lien de paiement à envoyer à la ferme : adresse STABLE de Massla (/api/payer/<jeton>, routes/payer.js), qui crée un
 * checkout PayDunya tout frais à chaque ouverture — un checkout PayDunya expire ~30 minutes après sa création, un
 * lien direct serait mort avant même d'être lu (voir paiementsSaas.js). On vérifie ici que la facture est payable et
 * que PayDunya est configuré, pour que le superviseur voie l'erreur tout de suite plutôt que la ferme.
 * `req.db` doit porter le contexte du superviseur (requireAuth + requireSuperviseurPlateforme).
 */
async function lienPaiementStable(req, facture) {
    verifierFacturePayable(facture);
    const credentials = await getPaydunyaConfig(req.db, req.user.tenant_id);
    if (!credentials) {
        throw erreurHttp(400, 'Aucun compte PayDunya configuré pour Massla (Réglages de la ferme, section Paiement) : impossible de générer un lien de paiement.');
    }
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    return { url: `${base}/api/payer/${creerJeton(facture.id)}`, mode: credentials.mode };
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
     * Activité des fermes clientes sur 7 / 30 jours, pour savoir quel pilote relancer et quand :
     * dernière connexion, saisies métier, principaux écrans utilisés. Ne renvoie que des compteurs et
     * des dates, jamais le contenu d'une saisie (audit_logs.details n'est même pas lu). Source =
     * journal d'audit (lecture cross-tenant ouverte au superviseur par migration-26) ; les actions de
     * support (connexion en tant qu'admin, impersonation) sont exclues pour ne pas faire passer une
     * intervention de Massla pour de l'activité du client. Ferme Massla elle-même est exclue.
     * Comptage en JS plutôt qu'en SQL agrégé : mêmes limites pg-mem que GET /organisations.
     */
    router.get('/activite', ...garde, async (req, res) => {
        try {
            const maintenant = new Date();
            const il7 = new Date(maintenant.getTime() - 7 * JOUR_MS);
            const il30 = new Date(maintenant.getTime() - 30 * JOUR_MS);

            const [orgsRes, abosRes, recentRes, connexionsRes] = await Promise.all([
                req.db.query(`SELECT id, nom, cree_le FROM organisations WHERE deleted_at IS NULL AND est_plateforme = FALSE`),
                req.db.query(`SELECT tenant_id, actif, montant_mensuel FROM organisation_abonnement_saas`),
                req.db.query(
                    `SELECT tenant_id, table_name, action, utilisateur_id, cree_le FROM audit_logs
                     WHERE tenant_id IS NOT NULL AND impersonation = FALSE AND cree_le >= $1
                     ORDER BY cree_le DESC LIMIT 50000`,
                    [il30]
                ),
                req.db.query(
                    `SELECT tenant_id, MAX(cree_le) AS derniere FROM audit_logs
                     WHERE tenant_id IS NOT NULL AND impersonation = FALSE AND action = 'LOGIN' GROUP BY tenant_id`
                ),
            ]);

            const aboParOrg = new Map(abosRes.rows.map((a) => [a.tenant_id, a]));
            const derniereConnexion = new Map(connexionsRes.rows.map((c) => [c.tenant_id, c.derniere]));
            const evenementsParOrg = new Map();
            for (const e of recentRes.rows) {
                if (!evenementsParOrg.has(e.tenant_id)) evenementsParOrg.set(e.tenant_id, []);
                evenementsParOrg.get(e.tenant_id).push(e);
            }

            // Les fermes qui demandent une action passent en premier.
            const ORDRE_STATUT = { jamais: 0, inactive: 1, connecte_sans_saisie: 2, active: 3 };
            const fermes = orgsRes.rows.map((o) => {
                const evenements = evenementsParOrg.get(o.id) || [];
                const connexions7 = evenements.filter((e) => e.action === 'LOGIN' && new Date(e.cree_le) >= il7);
                const saisies = evenements.filter((e) => ACTIONS_SAISIE.includes(e.action) && !TABLES_HORS_SAISIE.has(e.table_name));
                const saisies7 = saisies.filter((e) => new Date(e.cree_le) >= il7);

                const parTable = new Map();
                for (const e of saisies7) parTable.set(e.table_name, (parTable.get(e.table_name) || 0) + 1);
                const joursActifs = new Set(saisies7.map((e) => new Date(e.cree_le).toISOString().slice(0, 10)));

                const derniere = derniereConnexion.get(o.id) || null;
                let statut;
                if (!derniere) statut = 'jamais';
                else if (saisies7.length > 0) statut = 'active';
                else if (new Date(derniere) >= il7) statut = 'connecte_sans_saisie';
                else statut = 'inactive';

                const abo = aboParOrg.get(o.id);
                return {
                    id: o.id,
                    nom: o.nom,
                    cree_le: o.cree_le,
                    abonnement: abo ? { actif: abo.actif, montant_mensuel: abo.montant_mensuel } : null,
                    statut,
                    derniere_connexion: derniere,
                    connexions_7j: connexions7.length,
                    utilisateurs_connectes_7j: new Set(connexions7.map((e) => e.utilisateur_id)).size,
                    saisies_7j: saisies7.length,
                    saisies_30j: saisies.length,
                    jours_actifs_7j: joursActifs.size,
                    derniere_saisie: saisies.length ? saisies[0].cree_le : null,
                    principales_saisies_7j: [...parTable.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([table, n]) => ({ table, n })),
                };
            });
            fermes.sort((a, b) => ORDRE_STATUT[a.statut] - ORDRE_STATUT[b.statut] || new Date(b.cree_le) - new Date(a.cree_le));

            res.json({ genere_le: maintenant.toISOString(), fermes });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors du calcul de l'activité des fermes." });
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
            await logAudit(req.db, { req, table: 'organisations', rowId: tenantId, action: 'DELETE', userId: req.user.id, tenantId, details: { superviseur: req.user.nom } });
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
            await logAudit(req.db, { req, table: 'organisations', rowId: tenantId, action: 'UPDATE', userId: req.user.id, tenantId, details: { slug } });
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
                `SELECT u.id, u.nom_complet, u.email, u.secteur_id, u.tenant_id, u.token_version, o.nom as organisation_nom
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
            const token = signToken({ ...admin, role_nom: 'admin' }, { viaImpersonation: true, supervisorId: req.user.id });
            await logAudit(req.db, { req,
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

    /**
     * Contrepartie de /se-connecter-admin : journalise la fin d'une session d'impersonation, pour
     * que le journal d'audit de la ferme cible montre non seulement quand le support s'est connecté
     * (CONNEXION_SUPPORT ci-dessus) mais aussi quand il est reparti — audit sécurité 2026-08-11 (E4).
     * Appelée par le frontend juste avant de restaurer la session superviseur (bouton "Retour à la
     * supervision", app.js), donc AVEC le token d'impersonation encore valide, pas celui du
     * superviseur (`requireSuperviseurPlateforme` refuserait ce token — l'admin ciblé n'a lui-même
     * jamais ce flag). Pas de garde superviseur ici : n'importe quel token d'impersonation valide
     * peut clore SA PROPRE session, ce qui est le seul cas d'usage prévu.
     */
    router.post('/fin-session-support', requireAuth(pool), async (req, res) => {
        if (!req.user.impersonation) {
            return res.status(400).json({ erreur: "Cette route ne s'applique qu'à une session d'impersonation." });
        }
        await logAudit(req.db, { req,
            table: 'utilisateurs',
            rowId: req.user.id,
            action: 'FIN_SUPPORT', // audit_logs.action est VARCHAR(20) : 'FIN_CONNEXION_SUPPORT' (22) dépasse
            userId: req.user.id,
            tenantId: req.user.tenant_id,
            details: {},
        });
        res.status(204).end();
    });

    /**
     * Secteurs de production d'une ferme (Avicole/Piscicole/Maraîcher/autre) — jusqu'ici choisis
     * une fois pour toutes à la création (creerFerme.js), sans moyen d'en ajouter un ensuite. Ces
     * deux routes permettent à la vue plateforme de lister les secteurs actuels d'une ferme et d'en
     * ajouter un nouveau, typiquement quand un client upgrade son abonnement pour un secteur
     * supplémentaire — voir l'échappatoire SELECT/INSERT dédiée dans rls-policies.sql.
     */
    router.get('/organisations/:id/secteurs', ...garde, async (req, res) => {
        try {
            const result = await req.db.query(
                `SELECT id, nom, suivi_recolte, parent_secteur_id, suivi_individuel FROM secteurs WHERE tenant_id = $1 ORDER BY id`,
                [req.params.id]
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des secteurs.' });
        }
    });

    router.post('/organisations/:id/secteurs', ...garde, async (req, res) => {
        try {
            const tenantId = req.params.id;
            const nom = String(req.body.nom || '').trim();
            if (!nom) return res.status(400).json({ erreur: 'Le nom du secteur est requis.' });
            // Audit sécurité 2026-08-11 (M2) : voir le commentaire équivalent dans creerFerme.js.
            if (!nomSecteurValide(nom)) {
                return res.status(400).json({ erreur: 'Le nom du secteur ne peut contenir que lettres, chiffres, espaces et tirets (50 caractères max).' });
            }

            const existant = await req.db.query(`SELECT id FROM secteurs WHERE tenant_id = $1 AND lower(nom) = lower($2)`, [tenantId, nom]);
            if (existant.rows.length > 0) return res.status(409).json({ erreur: 'Ce secteur existe déjà pour cette ferme.' });

            // parentSecteurId optionnel (ex: "Bovins" sous "Élevage") — profondeur max 1 niveau : un
            // secteur qui a déjà lui-même un parent ne peut pas devenir parent à son tour.
            let parentSecteurId = null;
            if (req.body.parentSecteurId) {
                const parentRes = await req.db.query(
                    `SELECT id, parent_secteur_id FROM secteurs WHERE id = $1 AND tenant_id = $2`,
                    [req.body.parentSecteurId, tenantId]
                );
                if (parentRes.rows.length === 0) return res.status(400).json({ erreur: 'Secteur parent invalide.' });
                if (parentRes.rows[0].parent_secteur_id) {
                    return res.status(400).json({ erreur: 'Un secteur ne peut pas être imbriqué sur plus d\'un niveau.' });
                }
                parentSecteurId = parentRes.rows[0].id;
            }

            const result = await req.db.query(
                `INSERT INTO secteurs (tenant_id, nom, suivi_recolte, parent_secteur_id, suivi_individuel)
                 VALUES ($1, $2, $3, $4, $5) RETURNING id, nom, suivi_recolte, parent_secteur_id, suivi_individuel`,
                [tenantId, nom, !!req.body.suiviRecolte, parentSecteurId, !!req.body.suiviIndividuel]
            );
            await logAudit(req.db, { req, table: 'secteurs', rowId: result.rows[0].id, action: 'CREATE', userId: req.user.id, tenantId, details: { nom, superviseur: req.user.nom } });
            res.status(201).json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la création du secteur.' });
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
            const { modulesActifs, montantMensuel, fraisConfiguration, actif, telephoneContact } = req.body;
            if (!Array.isArray(modulesActifs) || !(Number(montantMensuel) > 0)) {
                return res.status(400).json({ erreur: 'Modules actifs et montant mensuel (positif) sont requis.' });
            }

            const existant = await req.db.query(`SELECT tenant_id, frais_configuration_facture FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenantId]);

            let result;
            if (existant.rows.length === 0) {
                result = await req.db.query(
                    `INSERT INTO organisation_abonnement_saas (tenant_id, modules_actifs, montant_mensuel, frais_configuration, actif, telephone_contact)
                     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                    [tenantId, modulesActifs, montantMensuel, fraisConfiguration || null, actif !== false, telephoneContact || null]
                );
                if (Number(fraisConfiguration) > 0) {
                    await req.db.query(
                        `INSERT INTO factures_saas (tenant_id, type, montant, date_echeance) VALUES ($1, 'CONFIGURATION', $2, $3)`,
                        [tenantId, fraisConfiguration, dansNJours(DELAI_PAIEMENT_JOURS)]
                    );
                    result = await req.db.query(
                        `UPDATE organisation_abonnement_saas SET frais_configuration_facture = TRUE WHERE tenant_id = $1 RETURNING *`,
                        [tenantId]
                    );
                }
            } else {
                result = await req.db.query(
                    `UPDATE organisation_abonnement_saas SET modules_actifs = $1, montant_mensuel = $2, actif = $3, telephone_contact = $4 WHERE tenant_id = $5 RETURNING *`,
                    [modulesActifs, montantMensuel, actif !== false, telephoneContact || null, tenantId]
                );
            }

            await logAudit(req.db, { req, table: 'organisation_abonnement_saas', rowId: tenantId, action: 'UPDATE', userId: req.user.id, tenantId, details: req.body });
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
            // Une ferme supprimée (deleted_at) n'est plus facturée, même si sa ligne d'abonnement est restée active.
            const abonnements = await req.db.query(
                `SELECT a.tenant_id, a.montant_mensuel FROM organisation_abonnement_saas a
                 JOIN organisations o ON o.id = a.tenant_id
                 WHERE a.actif = TRUE AND o.deleted_at IS NULL`
            );

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
                    [ab.tenant_id, periode, ab.montant_mensuel, dansNJours(DELAI_PAIEMENT_JOURS)]
                );
                resultats.creees += 1;
            }

            await logAudit(req.db, { req, table: 'factures_saas', action: 'CREATE', userId: req.user.id, tenantId: null, details: { periode, ...resultats } });
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
            await logAudit(req.db, { req, table: 'factures_saas', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: result.rows[0].tenant_id, details: req.body });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la mise à jour de la facture.' });
        }
    });

    /**
     * Lien de paiement en ligne (PayDunya : Wave, Orange Money, carte) d'une facture SaaS. Le superviseur le
     * copie et l'envoie à la ferme (WhatsApp, SMS...) ; le rappel par email l'inclut aussi. Quand la ferme paie,
     * l'IPN (paiementsSaas.js) marque la facture payée toute seule — plus de « Marquer payée » à la main.
     * Les fonds arrivent sur le compte PayDunya de l'organisation du superviseur (Massla).
     */
    router.post('/factures-saas/:id/lien-paiement', ...garde, async (req, res) => {
        try {
            const facture = await chargerFactureSaas(req.db, req.params.id);
            if (!facture) return res.status(404).json({ erreur: 'Facture introuvable.' });
            res.json(await lienPaiementStable(req, facture));
        } catch (err) {
            if (err.statutHttp) return res.status(err.statutHttp).json({ erreur: err.message });
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la génération du lien de paiement.' });
        }
    });

    /**
     * Relance de facture SaaS en retard/à payer via WhatsApp (server/src/whatsapp.js) — déclenchée
     * manuellement, pas automatique, même philosophie que "Générer les factures du mois". Le
     * message renvoyé en cas d'échec (err.message, exposé ici contrairement au reste de ce fichier)
     * est volontairement précis : réservé au superviseur, c'est un diagnostic opérationnel utile
     * (jeton WhatsApp expiré, numéro non configuré...), pas une fuite d'information sensible.
     */
    router.post('/factures-saas/:id/rappel-whatsapp', ...garde, async (req, res) => {
        try {
            const factureRes = await req.db.query(
                `SELECT f.id, f.montant, f.tenant_id, o.nom as organisation_nom, a.telephone_contact
                 FROM factures_saas f
                 JOIN organisations o ON f.tenant_id = o.id
                 LEFT JOIN organisation_abonnement_saas a ON a.tenant_id = f.tenant_id
                 WHERE f.id = $1`,
                [req.params.id]
            );
            if (factureRes.rows.length === 0) return res.status(404).json({ erreur: 'Facture introuvable.' });
            const facture = factureRes.rows[0];
            if (!facture.telephone_contact) {
                return res.status(400).json({ erreur: "Aucun numéro WhatsApp configuré pour cette ferme (voir la fenêtre Abonnement SaaS)." });
            }

            await envoyerMessageWhatsapp(facture.telephone_contact, { montant: facture.montant });
            await logAudit(req.db, { req,
                table: 'factures_saas',
                rowId: facture.id,
                action: 'RAPPEL_WHATSAPP',
                userId: req.user.id,
                tenantId: facture.tenant_id,
                details: { montant: facture.montant, telephone: facture.telephone_contact, superviseur: req.user.nom },
            });
            res.json({ envoye: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: err.message || "Erreur lors de l'envoi du rappel WhatsApp." });
        }
    });

    /**
     * Relance de facture SaaS par email (server/src/email.js) — alternative à la relance WhatsApp
     * ci-dessus tant que le numéro WhatsApp Business de la plateforme reste bloqué (voir mémoire
     * erp_ferme_whatsapp_status). Envoyée à tous les admins actifs de la ferme cliente : leur email
     * est déjà connu (utilisateurs.email), pas besoin d'un telephone_contact configuré à part.
     */
    router.post('/factures-saas/:id/rappel-email', ...garde, async (req, res) => {
        try {
            const facture = await chargerFactureSaas(req.db, req.params.id);
            if (!facture) return res.status(404).json({ erreur: 'Facture introuvable.' });

            const adminsRes = await req.db.query(
                `SELECT u.email FROM utilisateurs u JOIN roles r ON u.role_id = r.id
                 WHERE u.tenant_id = $1 AND r.nom = 'admin' AND u.actif = TRUE AND u.deleted_at IS NULL`,
                [facture.tenant_id]
            );
            const emails = adminsRes.rows.map((r) => r.email);
            if (emails.length === 0) {
                return res.status(400).json({ erreur: "Aucun administrateur actif trouvé pour cette ferme." });
            }

            // Lien de paiement en ligne joint au rappel, quand c'est possible : le rappel part de toute façon
            // sans lien si PayDunya n'est pas configuré ou si PayDunya est injoignable.
            let lienPaiement = null;
            try {
                lienPaiement = (await lienPaiementStable(req, facture)).url;
            } catch (err) {
                if (!err.statutHttp) console.error(err);
            }

            await envoyerEmailRappelSaas(emails, {
                organisationNom: facture.organisation_nom,
                montant: facture.montant,
                dateEcheance: facture.date_echeance,
                type: facture.type,
                lienPaiement,
            });
            await logAudit(req.db, { req,
                table: 'factures_saas',
                rowId: facture.id,
                action: 'RAPPEL_EMAIL',
                userId: req.user.id,
                tenantId: facture.tenant_id,
                details: { montant: facture.montant, emails, superviseur: req.user.nom, lien_paiement_inclus: !!lienPaiement },
            });
            res.json({ envoye: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: err.message || "Erreur lors de l'envoi du rappel par email." });
        }
    });

    /**
     * Modération des avis publics (site vitrine massla.sn/decouvrir, section "Avis clients") — un
     * visiteur peut soumettre un avis (routes/avis.js, public) mais seul le superviseur peut le
     * publier. Tous les avis (approuvés et en attente) sont renvoyés ici, contrairement à
     * GET /api/avis (public) qui ne renvoie que les approuvés.
     */
    router.get('/avis', ...garde, async (req, res) => {
        try {
            const result = await req.db.query(
                `SELECT id, nom, nom_ferme, note, commentaire, approuve, cree_le FROM avis_publics ORDER BY cree_le DESC`
            );
            res.json(result.rows);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des avis.' });
        }
    });

    router.put('/avis/:id', ...garde, async (req, res) => {
        try {
            const result = await req.db.query(
                `UPDATE avis_publics SET approuve = $1 WHERE id = $2 RETURNING id, approuve`,
                [!!req.body.approuve, req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Avis introuvable.' });
            await logAudit(req.db, { req, table: 'avis_publics', rowId: req.params.id, action: 'UPDATE', userId: req.user.id, tenantId: null, details: { approuve: !!req.body.approuve, superviseur: req.user.nom } });
            res.json(result.rows[0]);
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la mise à jour de l'avis." });
        }
    });

    router.delete('/avis/:id', ...garde, async (req, res) => {
        try {
            const result = await req.db.query(`DELETE FROM avis_publics WHERE id = $1 RETURNING id`, [req.params.id]);
            if (result.rows.length === 0) return res.status(404).json({ erreur: 'Avis introuvable.' });
            await logAudit(req.db, { req, table: 'avis_publics', rowId: req.params.id, action: 'DELETE', userId: req.user.id, tenantId: null, details: { superviseur: req.user.nom } });
            res.status(204).end();
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la suppression de l'avis." });
        }
    });

    return router;
};

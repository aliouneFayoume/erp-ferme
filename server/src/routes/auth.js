const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signToken, requireAuth, attachTenantConnection } = require('../auth');
const { logAudit } = require('../audit');

// Limite le brute-force sur les mots de passe : 10 tentatives / 15 min par IP, au-delà d'un usage
// normal (un utilisateur qui se trompe de mot de passe) mais bien en-deçà d'un balayage automatisé.
const limiteurLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives de connexion. Réessayez plus tard.' },
});

module.exports = function authRoutes(pool) {
    const router = express.Router();

    router.post('/login', limiteurLogin, async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ erreur: 'Email et mot de passe requis.' });
        }

        try {
            const result = await pool.query(
                `SELECT u.id, u.nom_complet, u.email, u.mot_de_passe_hash, u.secteur_id, u.tenant_id, u.actif,
                        u.est_superviseur_plateforme, r.nom as role_nom, o.nom as organisation_nom, o.deleted_at as organisation_supprimee_le
                 FROM utilisateurs u JOIN roles r ON u.role_id = r.id LEFT JOIN organisations o ON u.tenant_id = o.id
                 WHERE u.email = $1 AND u.deleted_at IS NULL`,
                [email]
            );

            const user = result.rows[0];
            if (!user || !user.actif) {
                return res.status(401).json({ erreur: 'Identifiants incorrects.' });
            }

            const valide = await bcrypt.compare(password, user.mot_de_passe_hash);
            if (!valide) {
                return res.status(401).json({ erreur: 'Identifiants incorrects.' });
            }

            if (user.organisation_supprimee_le) {
                return res.status(403).json({ erreur: 'Cette organisation a été supprimée. Contactez le support.' });
            }

            const token = signToken(user);
            // Le tenant vient d'être découvert (aucun contexte au démarrage de cette requête,
            // pré-authentification) : on pose maintenant le contexte RLS, sans quoi l'écriture dans
            // audit_logs (stricte : tenant_id = current_tenant_id() OR is_plateforme_admin(), voir
            // rls-policies.sql) est rejetée pour CHAQUE connexion réussie — même comportement que
            // l'IPN PayDunya (finance.js) une fois le tenant résolu. Fait aussi passer la policy
            // "tenant_id = current_tenant_id()" de organisation_abonnement_saas juste en-dessous : sur
            // une connexion pool brute (sans contexte), cette table n'a PAS d'échappatoire pré-tenant
            // (données commerciales, contrairement à utilisateurs/clients/organisations) — la vérifier
            // avant d'avoir posé le contexte renverrait toujours "aucune ligne", donc jamais bloqué.
            await attachTenantConnection(req, res, pool, user.tenant_id);

            const abonnementRes = await req.db.query(`SELECT actif FROM organisation_abonnement_saas WHERE tenant_id = $1`, [user.tenant_id]);
            if (abonnementRes.rows.length > 0 && abonnementRes.rows[0].actif === false) {
                return res.status(403).json({ erreur: 'Accès suspendu pour cette organisation. Contactez le support.' });
            }

            await logAudit(req.db, { table: 'utilisateurs', rowId: user.id, action: 'LOGIN', userId: user.id, tenantId: user.tenant_id });

            res.json({
                token,
                utilisateur: {
                    id: user.id,
                    nom_complet: user.nom_complet,
                    email: user.email,
                    role: user.role_nom,
                    secteur_id: user.secteur_id,
                    tenant_id: user.tenant_id,
                    organisation_nom: user.organisation_nom,
                    superviseurPlateforme: !!user.est_superviseur_plateforme,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion.' });
        }
    });

    router.get('/me', requireAuth(pool), (req, res) => {
        res.json({ utilisateur: req.user });
    });

    return router;
};

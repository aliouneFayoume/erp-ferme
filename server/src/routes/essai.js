// Essai gratuit autonome (Easystart phase 3, migration-35) : inscription et connexion par numéro WhatsApp + code à 6 chiffres,
// sans e-mail ni mot de passe. Les trois routes publiques répondent TOUJOURS la même chose que le numéro existe ou non
// (jamais de « ce numéro n'a pas de compte ») : seule la saisie du bon code ouvre une session.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { signToken, requireAuth, checkRole, queryPreTenant, queryAvecTenant, attachTenantConnection } = require('../auth');
const { logAudit } = require('../audit');
const { normaliserTelephone } = require('../validation');
const { creerFermeEssai } = require('../creerFermeEssai');
const {
    MAX_TENTATIVES_CODE,
    DELAI_RENVOI_SECONDES,
    essaiAutonomeDisponible,
    genererCodeConnexion,
    codeCorrespond,
    envoyerCodeConnexion,
} = require('../essaiAutonome');

const limiteur = (fenetreMinutes, limite, message) =>
    rateLimit({
        windowMs: fenetreMinutes * 60 * 1000,
        limit: limite,
        standardHeaders: true,
        legacyHeaders: false,
        message: { erreur: message },
    });

// Une inscription crée une ferme ET déclenche un message WhatsApp facturé : plus strict qu'une simple connexion.
const limiteurInscription = limiteur(60, 5, "Trop de tentatives d'inscription. Réessayez plus tard.");
// Demander un code = un message WhatsApp envoyé à un tiers : même plafond que l'inscription.
const limiteurCode = limiteur(60, 8, 'Trop de demandes de code. Réessayez plus tard.');
// Un code à 6 chiffres a peu d'entropie : en plus des 5 essais par code (base), un plafond par adresse IP.
const limiteurVerifier = limiteur(15, 10, 'Trop de tentatives. Réessayez plus tard.');

const MESSAGE_CODE_ENVOYE = (telephone) =>
    `Si ce numéro peut recevoir WhatsApp, un code à 6 chiffres vient de lui être envoyé (${telephone}). Il est valable 10 minutes. ` +
    `Pas reçu ? Vous pouvez en redemander un au bout d'une minute.`;
const MESSAGE_CODE_INVALIDE = 'Code incorrect ou expiré. Redemandez un code.';
const NOM_FERME_REGEX = /^[^<>\u0000-\u001F]{2,100}$/;

function exigerDisponible(req, res, next) {
    if (!essaiAutonomeDisponible()) {
        return res.status(503).json({ erreur: "L'essai gratuit n'est pas encore ouvert. Demandez votre démonstration, nous vous répondons sur WhatsApp." });
    }
    next();
}

module.exports = function essaiRoutes(pool) {
    const router = express.Router();

    /** Compte (essai) rattaché à ce numéro, ferme non supprimée — lecture avant tout contexte tenant (policy pré-tenant). */
    async function trouverParTelephone(telephone) {
        const r = await queryPreTenant(
            pool,
            `SELECT u.id, u.tenant_id, u.actif, u.token_version, u.login_code_envoye_le, o.deleted_at AS organisation_supprimee_le
             FROM utilisateurs u LEFT JOIN organisations o ON o.id = u.tenant_id
             WHERE u.telephone = $1 AND u.deleted_at IS NULL`,
            [telephone]
        );
        const u = r.rows[0];
        return u && u.actif && !u.organisation_supprimee_le ? u : null;
    }

    /** Génère, enregistre et envoie un code — sans rien révéler à l'appelant (mêmes réponses dans tous les cas). */
    async function envoyerNouveauCode(utilisateur, telephone) {
        const dernier = utilisateur.login_code_envoye_le ? new Date(utilisateur.login_code_envoye_le).getTime() : 0;
        if (Date.now() - dernier < DELAI_RENVOI_SECONDES * 1000) return; // trop tôt : on ne renvoie pas, sans le dire
        const { code, hash, expireLe } = genererCodeConnexion();
        await queryAvecTenant(
            pool,
            utilisateur.tenant_id,
            `UPDATE utilisateurs SET login_code_hash = $1, login_code_expire_le = $2, login_code_tentatives = 0, login_code_envoye_le = now() WHERE id = $3`,
            [hash, expireLe, utilisateur.id]
        );
        try {
            await envoyerCodeConnexion(telephone, code);
        } catch (err) {
            // Non bloquant côté réponse (sinon on révélerait l'existence du compte) : le code stocké reste inutilisable sans
            // avoir été reçu, l'utilisateur redemande au bout d'une minute.
            console.error("Échec de l'envoi du code de connexion par WhatsApp :", err.message);
        }
    }

    router.get('/disponible', (req, res) => {
        res.json({ disponible: essaiAutonomeDisponible() });
    });

    /** Ouvre un essai (ou, si le numéro a déjà un compte, envoie simplement un code de connexion). */
    router.post('/inscription', limiteurInscription, exigerDisponible, async (req, res) => {
        const nomFerme = typeof req.body.nomFerme === 'string' ? req.body.nomFerme.trim() : '';
        const telephone = normaliserTelephone(req.body.telephone);
        const source = req.body.source === 'demo' ? 'demo' : 'essai';
        if (!NOM_FERME_REGEX.test(nomFerme)) {
            return res.status(400).json({ erreur: 'Le nom de la ferme est requis (2 à 100 caractères).' });
        }
        if (!telephone) {
            return res.status(400).json({ erreur: 'Numéro WhatsApp invalide. Exemple : +221 77 000 00 00.' });
        }
        try {
            let utilisateur = await trouverParTelephone(telephone);
            if (!utilisateur) {
                try {
                    await creerFermeEssai(pool, { nomFerme, telephone, source });
                } catch (err) {
                    // Deux inscriptions simultanées avec le même numéro : la base tranche (téléphone UNIQUE) ; la perdante
                    // continue simplement comme une connexion. Toute autre erreur remonte.
                    if (err.code !== '23505') throw err;
                }
                utilisateur = await trouverParTelephone(telephone);
            }
            if (utilisateur) await envoyerNouveauCode(utilisateur, telephone);
            res.status(202).json({ message: MESSAGE_CODE_ENVOYE(telephone) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'ouverture de l'essai." });
        }
    });

    /** Demande d'un code de connexion pour un compte existant. */
    router.post('/code', limiteurCode, exigerDisponible, async (req, res) => {
        const telephone = normaliserTelephone(req.body.telephone);
        if (!telephone) {
            return res.status(400).json({ erreur: 'Numéro WhatsApp invalide. Exemple : +221 77 000 00 00.' });
        }
        try {
            const utilisateur = await trouverParTelephone(telephone);
            if (utilisateur) await envoyerNouveauCode(utilisateur, telephone);
            res.status(202).json({ message: MESSAGE_CODE_ENVOYE(telephone) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'envoi du code." });
        }
    });

    /** Vérifie le code et ouvre la session (même réponse que POST /api/auth/login). */
    router.post('/verifier', limiteurVerifier, exigerDisponible, async (req, res) => {
        const telephone = normaliserTelephone(req.body.telephone);
        const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
        if (!telephone || !/^\d{6}$/.test(code)) {
            return res.status(400).json({ erreur: 'Numéro et code à 6 chiffres requis.' });
        }
        try {
            const r = await queryPreTenant(
                pool,
                `SELECT u.id, u.nom_complet, u.email, u.telephone, u.secteur_id, u.tenant_id, u.actif, u.token_version,
                        u.login_code_hash, u.login_code_expire_le, u.login_code_tentatives,
                        r.nom AS role_nom, o.nom AS organisation_nom, o.deleted_at AS organisation_supprimee_le
                 FROM utilisateurs u JOIN roles r ON r.id = u.role_id LEFT JOIN organisations o ON o.id = u.tenant_id
                 WHERE u.telephone = $1 AND u.deleted_at IS NULL`,
                [telephone]
            );
            const user = r.rows[0];
            if (!user || !user.actif || user.organisation_supprimee_le) {
                return res.status(401).json({ erreur: MESSAGE_CODE_INVALIDE });
            }
            const expire = user.login_code_expire_le ? new Date(user.login_code_expire_le).getTime() : 0;
            if (!user.login_code_hash || expire < Date.now() || user.login_code_tentatives >= MAX_TENTATIVES_CODE) {
                return res.status(401).json({ erreur: MESSAGE_CODE_INVALIDE });
            }
            if (!codeCorrespond(code, user.login_code_hash)) {
                // Au dernier essai raté, le code est détruit : il faut en redemander un (et attendre le délai de renvoi).
                await queryAvecTenant(
                    pool,
                    user.tenant_id,
                    `UPDATE utilisateurs SET login_code_tentatives = login_code_tentatives + 1,
                            login_code_hash = CASE WHEN login_code_tentatives + 1 >= $2 THEN NULL ELSE login_code_hash END
                     WHERE id = $1`,
                    [user.id, MAX_TENTATIVES_CODE]
                );
                return res.status(401).json({ erreur: MESSAGE_CODE_INVALIDE });
            }

            await attachTenantConnection(req, res, pool, user.tenant_id);
            const abonnement = await req.db.query(`SELECT actif FROM organisation_abonnement_saas WHERE tenant_id = $1`, [user.tenant_id]);
            if (abonnement.rows.length > 0 && abonnement.rows[0].actif === false) {
                return res.status(403).json({ erreur: 'Accès suspendu pour cette organisation. Contactez le support.' });
            }
            // Code à usage unique : consommé ici, et le numéro est désormais prouvé (reçu sur WhatsApp).
            await req.db.query(
                `UPDATE utilisateurs SET login_code_hash = NULL, login_code_expire_le = NULL, login_code_tentatives = 0, telephone_verifie = TRUE WHERE id = $1`,
                [user.id]
            );

            const token = signToken(user);
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: user.id, action: 'LOGIN', userId: user.id, tenantId: user.tenant_id, details: { methode: 'code_whatsapp' } });
            res.json({
                token,
                utilisateur: {
                    id: user.id,
                    nom_complet: user.nom_complet,
                    email: user.email,
                    telephone: user.telephone,
                    role: user.role_nom,
                    secteur_id: user.secteur_id,
                    tenant_id: user.tenant_id,
                    organisation_nom: user.organisation_nom,
                    superviseurPlateforme: false,
                    mfaSetupRequis: false,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion.' });
        }
    });

    /**
     * Supprime la ferme démo (« supprimable en un clic »). Soft delete du lot marqué est_demo, de ses ventes (commandes), du client
     * et du produit « démo » : ses relevés et ses coûts disparaissent des écrans avec le lot. Seules les lignes marquées est_demo
     * sont touchées — les données réelles de la ferme ne le sont jamais.
     */
    router.delete('/demo', requireAuth(pool), checkRole(['admin']), async (req, res) => {
        try {
            const tenantId = req.user.tenant_id;
            const r = await req.db.query(
                `UPDATE lots_production SET deleted_at = now() WHERE tenant_id = $1 AND est_demo = TRUE AND deleted_at IS NULL RETURNING id`,
                [tenantId]
            );
            await req.db.query(`UPDATE commandes SET deleted_at = now() WHERE tenant_id = $1 AND est_demo = TRUE AND deleted_at IS NULL`, [tenantId]);
            await req.db.query(`UPDATE clients SET deleted_at = now() WHERE tenant_id = $1 AND est_demo = TRUE AND deleted_at IS NULL`, [tenantId]);
            await req.db.query(`UPDATE produits SET deleted_at = now() WHERE tenant_id = $1 AND est_demo = TRUE AND deleted_at IS NULL`, [tenantId]);
            for (const ligne of r.rows) {
                await logAudit(req.db, { req, table: 'lots_production', rowId: ligne.id, action: 'DELETE', userId: req.user.id, tenantId, details: { demo: true } });
            }
            res.json({ supprimes: r.rows.length });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la suppression de la démo.' });
        }
    });

    return router;
};

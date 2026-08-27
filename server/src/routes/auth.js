const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { signToken, requireAuth, attachTenantConnection, queryPreTenant, queryAvecTenant, JWT_SECRET } = require('../auth');
const { logAudit } = require('../audit');
const { motDePasseValide, motDePasseErreurs } = require('../validation');
const mfa = require('../mfa');
const { chiffrer } = require('../credentials');
// Nommé `emailService` (pas `email`) : plusieurs routes ci-dessous destructurent `email` du body.
const emailService = require('../email');

// Limite le brute-force sur les mots de passe : 10 tentatives / 15 min par IP, au-delà d'un usage
// normal (un utilisateur qui se trompe de mot de passe) mais bien en-deçà d'un balayage automatisé.
const limiteurLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives de connexion. Réessayez plus tard.' },
});

// Un code MFA à 6 chiffres a peu d'entropie : même raisonnement que le PIN du portail client
// (portail.js) — limite dédiée, distincte du login lui-même déjà passé à ce stade.
const limiteurMfaVerifier = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

// Renvoyer un email de vérification déclenche un envoi réel (coût, et surface d'énumération) :
// limite volontairement stricte, comme l'inscription (routes/inscription.js).
const limiteurRenvoiVerification = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

// Cliquer un lien de vérification est un usage normal ponctuel, mais reste public : limite plus
// large que le login pour ne pas gêner un double-clic, tout en bornant un balayage de tokens.
const limiteurVerifierEmail = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

// Audit sécurité 2026-08-27 : ces routes vérifient `currentPassword` via bcrypt.compare mais
// n'avaient aucune limite de tentatives, contrairement à /login — un jeton dérobé permettait de
// deviner le mot de passe réel par essais successifs sans jamais déclencher de verrouillage.
const limiteurCompteSensible = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives. Réessayez plus tard.' },
});

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

module.exports = function authRoutes(pool) {
    const router = express.Router();

    router.post('/login', limiteurLogin, async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ erreur: 'Email et mot de passe requis.' });
        }

        try {
            const result = await queryPreTenant(
                pool,
                `SELECT u.id, u.nom_complet, u.email, u.mot_de_passe_hash, u.secteur_id, u.tenant_id, u.actif, u.token_version,
                        u.est_superviseur_plateforme, u.email_verifie, u.mfa_actif, u.mfa_methode, u.mfa_obligatoire,
                        u.mfa_totp_secret_chiffre, u.mfa_whatsapp_numero,
                        r.nom as role_nom, o.nom as organisation_nom, o.deleted_at as organisation_supprimee_le
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

            // Durcissement sécurité (migration-20) : bloquant, mais uniquement pour les comptes créés
            // après la migration (email_verifie=TRUE par défaut/grandfathering pour tout compte
            // préexistant — voir migration-20-securite-auth.sql).
            if (!user.email_verifie) {
                return res.status(403).json({ erreur: 'Adresse email non vérifiée. Consultez votre boîte mail.', code: 'EMAIL_NON_VERIFIE' });
            }

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

            // MFA actif : le mot de passe vient de prouver l'identité, mais la session complète
            // n'est émise qu'après vérification du second facteur — un JWT de défi de courte durée
            // (5 min) porte l'identité déjà vérifiée sans donner accès à l'API.
            if (user.mfa_actif) {
                if (user.mfa_methode === 'WHATSAPP') {
                    const { code, hash, expireLe } = mfa.genererCodeWhatsapp();
                    await req.db.query(
                        `UPDATE utilisateurs SET mfa_code_hash = $1, mfa_code_expire_le = $2, mfa_code_tentatives = 0 WHERE id = $3`,
                        [hash, expireLe, user.id]
                    );
                    try {
                        await mfa.envoyerCodeWhatsapp(user.mfa_whatsapp_numero, code);
                    } catch (err) {
                        // Non bloquant côté réponse (même philosophie que les relances WhatsApp de
                        // facturation) : limite connue, le numéro WhatsApp Business de production est
                        // actuellement indisponible — voir suivi séparé. TOTP n'est pas affecté.
                        console.error("Échec de l'envoi du code MFA par WhatsApp :", err);
                    }
                }
                const challengeToken = jwt.sign({ id: user.id, mfaChallenge: true, tokenVersion: user.token_version }, JWT_SECRET, { expiresIn: '5m' });
                return res.json({ mfaRequis: true, mfaMethode: user.mfa_methode, challengeToken });
            }

            const token = signToken(user);
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: user.id, action: 'LOGIN', userId: user.id, tenantId: user.tenant_id });

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
                    mfaSetupRequis: user.role_nom === 'admin' && user.mfa_obligatoire && !user.mfa_actif,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion.' });
        }
    });

    /**
     * Deuxième étape du login quand mfa_actif=TRUE : consomme le challengeToken émis par /login
     * (jamais un token de session complet) et le code TOTP/WhatsApp pour émettre le vrai token.
     */
    router.post('/mfa/verifier', limiteurMfaVerifier, async (req, res) => {
        const { challengeToken, code } = req.body;
        if (!challengeToken || !code) {
            return res.status(400).json({ erreur: 'Code et jeton de défi requis.' });
        }

        let payload;
        try {
            payload = jwt.verify(challengeToken, JWT_SECRET);
        } catch (err) {
            return res.status(401).json({ erreur: 'Session de vérification invalide ou expirée. Reconnectez-vous.' });
        }
        if (!payload.mfaChallenge) {
            return res.status(401).json({ erreur: 'Jeton invalide.' });
        }

        try {
            const result = await queryPreTenant(
                pool,
                `SELECT u.id, u.nom_complet, u.email, u.secteur_id, u.tenant_id, u.actif, u.token_version,
                        u.est_superviseur_plateforme, u.mfa_methode, u.mfa_obligatoire, u.mfa_actif,
                        u.mfa_totp_secret_chiffre, u.mfa_code_hash, u.mfa_code_expire_le, u.mfa_code_tentatives,
                        r.nom as role_nom, o.nom as organisation_nom, o.deleted_at as organisation_supprimee_le
                 FROM utilisateurs u JOIN roles r ON u.role_id = r.id LEFT JOIN organisations o ON u.tenant_id = o.id
                 WHERE u.id = $1 AND u.deleted_at IS NULL`,
                [payload.id]
            );
            const user = result.rows[0];
            if (!user || !user.actif || user.token_version !== payload.tokenVersion) {
                return res.status(401).json({ erreur: 'Session de vérification invalide ou expirée. Reconnectez-vous.' });
            }
            if (user.organisation_supprimee_le) {
                return res.status(403).json({ erreur: 'Cette organisation a été supprimée. Contactez le support.' });
            }

            await attachTenantConnection(req, res, pool, user.tenant_id);

            const abonnementRes = await req.db.query(`SELECT actif FROM organisation_abonnement_saas WHERE tenant_id = $1`, [user.tenant_id]);
            if (abonnementRes.rows.length > 0 && abonnementRes.rows[0].actif === false) {
                return res.status(403).json({ erreur: 'Accès suspendu pour cette organisation. Contactez le support.' });
            }

            let valide = false;
            if (user.mfa_methode === 'TOTP') {
                valide = mfa.verifierTotp(code, user.mfa_totp_secret_chiffre);
            } else if (user.mfa_methode === 'WHATSAPP') {
                const nonExpire = user.mfa_code_expire_le && new Date(user.mfa_code_expire_le) > new Date();
                const tentativesRestantes = user.mfa_code_tentatives < mfa.MAX_TENTATIVES_CODE;
                if (nonExpire && tentativesRestantes && user.mfa_code_hash === mfa.hashCode(code)) {
                    valide = true;
                }
            }

            if (!valide) {
                if (user.mfa_methode === 'WHATSAPP') {
                    await req.db.query(`UPDATE utilisateurs SET mfa_code_tentatives = mfa_code_tentatives + 1 WHERE id = $1`, [user.id]);
                }
                return res.status(401).json({ erreur: 'Code invalide ou expiré.' });
            }

            if (user.mfa_methode === 'WHATSAPP') {
                await req.db.query(
                    `UPDATE utilisateurs SET mfa_code_hash = NULL, mfa_code_expire_le = NULL, mfa_code_tentatives = 0 WHERE id = $1`,
                    [user.id]
                );
            }

            const token = signToken(user);
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: user.id, action: 'LOGIN', userId: user.id, tenantId: user.tenant_id });

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
                    mfaSetupRequis: false,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la vérification.' });
        }
    });

    /** Changement de mot de passe self-service — jusqu'ici seul un admin pouvait réinitialiser celui d'un tiers (routes/utilisateurs.js). */
    router.put('/mot-de-passe', limiteurCompteSensible, requireAuth(pool), async (req, res) => {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ erreur: 'Mot de passe actuel et nouveau mot de passe requis.' });
        }
        if (!motDePasseValide(newPassword)) {
            return res.status(400).json({ erreur: `Le mot de passe doit contenir ${motDePasseErreurs(newPassword).join(', ')}.` });
        }
        try {
            const actuel = await req.db.query(`SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1`, [req.user.id]);
            if (actuel.rows.length === 0) return res.status(404).json({ erreur: 'Utilisateur introuvable.' });

            const valide = await bcrypt.compare(currentPassword, actuel.rows[0].mot_de_passe_hash);
            if (!valide) return res.status(401).json({ erreur: 'Mot de passe actuel incorrect.' });

            const hash = await bcrypt.hash(newPassword, 10);
            // token_version + 1 comme tout changement de mot de passe (voir routes/utilisateurs.js) —
            // mais ici l'appelant EST le compte modifié : on renvoie un nouveau token signé avec la
            // version à jour pour ne pas déconnecter l'utilisateur de sa propre session.
            const result = await req.db.query(
                `UPDATE utilisateurs SET mot_de_passe_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version`,
                [hash, req.user.id]
            );
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.user.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { motDePasseModifie: true } });

            const token = signToken({
                id: req.user.id,
                role_nom: req.user.role,
                nom_complet: req.user.nom,
                secteur_id: req.user.secteur_id,
                tenant_id: req.user.tenant_id,
                est_superviseur_plateforme: req.user.superviseurPlateforme,
                token_version: result.rows[0].token_version,
            });
            res.json({ message: 'Mot de passe mis à jour.', token });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors du changement de mot de passe.' });
        }
    });

    router.get('/verifier-email', limiteurVerifierEmail, async (req, res) => {
        const token = String(req.query.token || '');
        if (!token) return res.status(400).json({ erreur: 'Lien de vérification invalide.' });

        try {
            // Comparaison d'expiration faite en JS, pas en SQL (WHERE ... > now()) : pg-mem (tests)
            // ne sait pas comparer TIMESTAMP à now() (typé timestamptz) — même contournement déjà
            // en place pour clients.pin_bloque_jusqu (routes/portail.js).
            const result = await queryPreTenant(
                pool,
                `SELECT id, tenant_id, email_verification_expire_le FROM utilisateurs
                 WHERE email_verification_token_hash = $1 AND deleted_at IS NULL`,
                [hashToken(token)]
            );
            const row = result.rows[0];
            if (!row || !row.email_verification_expire_le || new Date(row.email_verification_expire_le) <= new Date()) {
                return res.status(400).json({ erreur: 'Lien de vérification invalide ou expiré.' });
            }

            await queryAvecTenant(
                pool,
                row.tenant_id,
                `UPDATE utilisateurs SET email_verifie = TRUE, email_verification_token_hash = NULL, email_verification_expire_le = NULL WHERE id = $1`,
                [row.id]
            );
            res.json({ message: 'Adresse email vérifiée. Vous pouvez maintenant vous connecter.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la vérification.' });
        }
    });

    router.post('/renvoyer-verification', limiteurRenvoiVerification, async (req, res) => {
        const { email } = req.body;
        // Toujours le même message, que le compte existe ou non, soit déjà vérifié ou non — évite
        // qu'un attaquant énumère les adresses email inscrites via cette route.
        const messageGenerique = { message: "Si un compte existe pour cette adresse et n'est pas encore vérifié, un email a été envoyé." };
        if (!email) return res.json(messageGenerique);

        try {
            const result = await queryPreTenant(
                pool,
                `SELECT id, tenant_id, nom_complet, email FROM utilisateurs WHERE email = $1 AND email_verifie = FALSE AND deleted_at IS NULL`,
                [email]
            );
            const row = result.rows[0];
            if (row) {
                const token = crypto.randomBytes(32).toString('hex');
                await queryAvecTenant(
                    pool,
                    row.tenant_id,
                    `UPDATE utilisateurs SET email_verification_token_hash = $1, email_verification_expire_le = now() + interval '24 hours' WHERE id = $2`,
                    [hashToken(token), row.id]
                );
                try {
                    await emailService.envoyerEmailVerification(row.email, row.nom_complet, token);
                } catch (err) {
                    console.error("Échec du renvoi de l'email de vérification :", err);
                }
            }
            res.json(messageGenerique);
        } catch (err) {
            console.error(err);
            res.json(messageGenerique);
        }
    });

    // --- Configuration MFA (compte déjà authentifié) --------------------------------------------

    /**
     * Audit sécurité 2026-08-27 : brancher un nouveau secret TOTP est l'équivalent de CHANGER le
     * second facteur — sans reconfirmation du mot de passe, un jeton dérobé (session partagée,
     * appareil non verrouillé, jeton qui fuit) suffisait à un attaquant pour y greffer SA propre
     * application d'authentification, sans jamais prouver connaître le mot de passe. Même exigence
     * que DELETE /mfa, désormais cohérente sur toute la surface MFA.
     */
    router.post('/mfa/totp/init', limiteurCompteSensible, requireAuth(pool), async (req, res) => {
        const { currentPassword } = req.body;
        if (!currentPassword) return res.status(400).json({ erreur: 'Mot de passe requis pour configurer le MFA.' });
        try {
            const actuel = await req.db.query(`SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1`, [req.user.id]);
            const valide = actuel.rows[0] && (await bcrypt.compare(currentPassword, actuel.rows[0].mot_de_passe_hash));
            if (!valide) return res.status(401).json({ erreur: 'Mot de passe incorrect.' });

            const secret = mfa.genererSecretTotp();
            // req.user (payload JWT) ne porte pas l'email (voir signToken, auth.js) — relu ici.
            const infosRes = await req.db.query(
                `SELECT u.email, o.nom AS organisation_nom FROM utilisateurs u LEFT JOIN organisations o ON o.id = u.tenant_id WHERE u.id = $1`,
                [req.user.id]
            );
            const { otpauthUrl, qrCodeDataUrl } = await mfa.genererQrCodeTotp(infosRes.rows[0]?.email || '', secret, infosRes.rows[0]?.organisation_nom);
            await req.db.query(`UPDATE utilisateurs SET mfa_totp_secret_chiffre = $1, mfa_methode = 'TOTP' WHERE id = $2`, [chiffrer(secret), req.user.id]);
            res.json({ secret, otpauthUrl, qrCodeDataUrl });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'initialisation du TOTP." });
        }
    });

    router.post('/mfa/totp/activer', requireAuth(pool), async (req, res) => {
        const { code } = req.body;
        try {
            const result = await req.db.query(`SELECT mfa_totp_secret_chiffre, mfa_methode FROM utilisateurs WHERE id = $1`, [req.user.id]);
            const row = result.rows[0];
            if (!row?.mfa_totp_secret_chiffre || row.mfa_methode !== 'TOTP') {
                return res.status(400).json({ erreur: "Aucune configuration TOTP en attente. Recommencez l'initialisation." });
            }
            if (!mfa.verifierTotp(code, row.mfa_totp_secret_chiffre)) {
                return res.status(400).json({ erreur: 'Code invalide.' });
            }
            await req.db.query(`UPDATE utilisateurs SET mfa_actif = TRUE WHERE id = $1`, [req.user.id]);
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.user.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { mfaActive: 'TOTP' } });
            res.json({ message: 'MFA (application d\'authentification) activé.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'activation du TOTP." });
        }
    });

    router.post('/mfa/whatsapp/init', limiteurCompteSensible, requireAuth(pool), async (req, res) => {
        // Mise en attente volontaire (2026-08-27) : voir le commentaire de whatsappMfaActif() dans
        // mfa.js — numéro WhatsApp Business de production bloqué + template Meta non approuvé.
        if (!mfa.whatsappMfaActif()) {
            return res.status(503).json({ erreur: 'MFA par WhatsApp pas encore disponible. Utilisez une application d\'authentification (TOTP).' });
        }
        const { currentPassword, numero: numeroBrut } = req.body;
        if (!currentPassword) return res.status(400).json({ erreur: 'Mot de passe requis pour configurer le MFA.' });
        const numero = String(numeroBrut || '').replace(/[^0-9+]/g, '');
        if (!numero) return res.status(400).json({ erreur: 'Numéro WhatsApp requis.' });
        try {
            // Même exigence que /mfa/totp/init (audit sécurité 2026-08-27) : brancher un nouveau
            // second facteur doit reprouver le mot de passe, pas juste posséder un jeton en cours.
            const actuel = await req.db.query(`SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1`, [req.user.id]);
            const valide = actuel.rows[0] && (await bcrypt.compare(currentPassword, actuel.rows[0].mot_de_passe_hash));
            if (!valide) return res.status(401).json({ erreur: 'Mot de passe incorrect.' });

            const { code, hash, expireLe } = mfa.genererCodeWhatsapp();
            await req.db.query(
                `UPDATE utilisateurs SET mfa_methode = 'WHATSAPP', mfa_whatsapp_numero = $1, mfa_code_hash = $2, mfa_code_expire_le = $3, mfa_code_tentatives = 0 WHERE id = $4`,
                [numero, hash, expireLe, req.user.id]
            );
            try {
                await mfa.envoyerCodeWhatsapp(numero, code);
            } catch (err) {
                console.error("Échec de l'envoi du code d'activation WhatsApp :", err);
                return res.status(503).json({ erreur: "Échec de l'envoi du code par WhatsApp. Réessayez plus tard." });
            }
            res.json({ message: 'Code envoyé par WhatsApp.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'initialisation du MFA WhatsApp." });
        }
    });

    router.post('/mfa/whatsapp/activer', requireAuth(pool), async (req, res) => {
        if (!mfa.whatsappMfaActif()) {
            return res.status(503).json({ erreur: 'MFA par WhatsApp pas encore disponible.' });
        }
        const { code } = req.body;
        try {
            const result = await req.db.query(
                `SELECT mfa_methode, mfa_code_hash, mfa_code_expire_le, mfa_code_tentatives FROM utilisateurs WHERE id = $1`,
                [req.user.id]
            );
            const row = result.rows[0];
            if (!row || row.mfa_methode !== 'WHATSAPP' || !row.mfa_code_hash) {
                return res.status(400).json({ erreur: "Aucune configuration WhatsApp en attente. Recommencez l'initialisation." });
            }
            const nonExpire = row.mfa_code_expire_le && new Date(row.mfa_code_expire_le) > new Date();
            const tentativesRestantes = row.mfa_code_tentatives < mfa.MAX_TENTATIVES_CODE;
            if (!nonExpire || !tentativesRestantes || row.mfa_code_hash !== mfa.hashCode(code)) {
                await req.db.query(`UPDATE utilisateurs SET mfa_code_tentatives = mfa_code_tentatives + 1 WHERE id = $1`, [req.user.id]);
                return res.status(400).json({ erreur: 'Code invalide ou expiré.' });
            }
            await req.db.query(
                `UPDATE utilisateurs SET mfa_actif = TRUE, mfa_code_hash = NULL, mfa_code_expire_le = NULL, mfa_code_tentatives = 0 WHERE id = $1`,
                [req.user.id]
            );
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.user.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { mfaActive: 'WHATSAPP' } });
            res.json({ message: 'MFA (WhatsApp) activé.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de l'activation du MFA WhatsApp." });
        }
    });

    /**
     * Désactivation, protégée par re-confirmation du mot de passe (défense en profondeur — une
     * session déjà ouverte a déjà passé le MFA, mais ceci protège contre une session détournée mais
     * pas totalement compromise). Pour un admin avec mfa_obligatoire=TRUE, le garde-fou de
     * requireAuth (auth.js) redemandera aussitôt la configuration à la requête suivante.
     */
    router.delete('/mfa', limiteurCompteSensible, requireAuth(pool), async (req, res) => {
        const { currentPassword } = req.body;
        if (!currentPassword) return res.status(400).json({ erreur: 'Mot de passe requis pour désactiver le MFA.' });
        try {
            const result = await req.db.query(`SELECT mot_de_passe_hash FROM utilisateurs WHERE id = $1`, [req.user.id]);
            const valide = result.rows[0] && (await bcrypt.compare(currentPassword, result.rows[0].mot_de_passe_hash));
            if (!valide) return res.status(401).json({ erreur: 'Mot de passe incorrect.' });

            await req.db.query(
                `UPDATE utilisateurs SET mfa_actif = FALSE, mfa_methode = NULL, mfa_totp_secret_chiffre = NULL,
                    mfa_whatsapp_numero = NULL, mfa_code_hash = NULL, mfa_code_expire_le = NULL, mfa_code_tentatives = 0
                 WHERE id = $1`,
                [req.user.id]
            );
            await logAudit(req.db, { req, table: 'utilisateurs', rowId: req.user.id, action: 'UPDATE', userId: req.user.id, tenantId: req.user.tenant_id, details: { mfaDesactive: true } });
            res.json({ message: 'MFA désactivé.' });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la désactivation du MFA.' });
        }
    });

    router.get('/me', requireAuth(pool), async (req, res) => {
        const result = await req.db.query(`SELECT mfa_actif, mfa_methode, mfa_obligatoire FROM utilisateurs WHERE id = $1`, [req.user.id]);
        const row = result.rows[0] || {};
        res.json({ utilisateur: { ...req.user, mfaActif: !!row.mfa_actif, mfaMethode: row.mfa_methode, mfaObligatoire: !!row.mfa_obligatoire } });
    });

    return router;
};

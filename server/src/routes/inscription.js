const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { signToken } = require('../auth');
const { logAudit } = require('../audit');

if (!process.env.SIGNUP_INVITE_CODE && process.env.DATABASE_URL) {
    throw new Error(
        'SIGNUP_INVITE_CODE doit être défini explicitement dès qu\'une vraie base de données (DATABASE_URL) est configurée.'
    );
}
if (!process.env.SIGNUP_INVITE_CODE) {
    console.warn('⚠️  SIGNUP_INVITE_CODE non défini : code de démonstration utilisé (pg-mem uniquement, jamais en production).');
}
const SIGNUP_INVITE_CODE = process.env.SIGNUP_INVITE_CODE || 'demo-inscription-ferme-massla';

// Volontairement strict : la création de compte est plus rare et plus sensible qu'un simple essai
// de connexion — pas besoin de laisser une marge pour les fautes de frappe répétées d'un usage normal.
const limiteurInscription = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { erreur: 'Trop de tentatives d\'inscription. Réessayez plus tard.' },
});

module.exports = function inscriptionRoutes(pool) {
    const router = express.Router();

    /**
     * Crée une nouvelle organisation (ferme cliente) en self-service : plus besoin d'intervention
     * SQL manuelle (voir 2-Guide-configuration-nouveau-client.docx, qui reste la procédure de secours
     * si cette route est indisponible). Protégée par un code d'invitation transmis par Alioune après
     * la vente — pas une inscription publique ouverte à n'importe qui.
     *
     * Toute la création (organisation + secteurs + premier compte admin) se fait sur UNE connexion
     * dédiée, dans une transaction : le contexte RLS (tenant_id) est posé juste après la création de
     * l'organisation, sur la même connexion, pour que les insertions suivantes (secteurs,
     * utilisateurs) passent la policy stricte de ces tables sans avoir besoin d'échappatoire dédiée —
     * seule `organisations` a une policy INSERT permissive (voir rls-policies.sql), puisqu'on ne peut
     * par définition pas connaître l'id d'une organisation avant de l'avoir créée.
     */
    router.post('/', limiteurInscription, async (req, res) => {
        const { code, nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword } = req.body;

        if (code !== SIGNUP_INVITE_CODE) {
            return res.status(403).json({ erreur: "Code d'invitation invalide." });
        }
        if (!nomFerme || !nomFerme.trim()) {
            return res.status(400).json({ erreur: 'Le nom de la ferme est requis.' });
        }
        if (!Array.isArray(secteurs) || secteurs.length === 0 || secteurs.some((s) => !s.nom || !s.nom.trim())) {
            return res.status(400).json({ erreur: 'Au moins un secteur d\'activité valide est requis.' });
        }
        if (!adminNomComplet || !adminEmail || !adminPassword) {
            return res.status(400).json({ erreur: 'Nom, email et mot de passe de l\'administrateur sont requis.' });
        }
        if (adminPassword.length < 8) {
            return res.status(400).json({ erreur: 'Le mot de passe doit contenir au moins 8 caractères.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const orgRes = await client.query(`INSERT INTO organisations (nom) VALUES ($1) RETURNING id`, [nomFerme.trim()]);
            const tenantId = orgRes.rows[0].id;

            // Pose le contexte tenant sur cette même connexion pour le reste de la transaction — voir
            // attachTenantConnection (auth.js) pour le mécanisme équivalent utilisé une fois authentifié.
            await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);

            for (const s of secteurs) {
                await client.query(`INSERT INTO secteurs (tenant_id, nom, suivi_recolte) VALUES ($1, $2, $3)`, [
                    tenantId,
                    s.nom.trim(),
                    !!s.suiviRecolte,
                ]);
            }

            const roleRes = await client.query(`SELECT id FROM roles WHERE nom = 'admin'`);
            if (roleRes.rows.length === 0) throw new Error("Rôle 'admin' introuvable — la base n'est pas correctement initialisée.");

            const hash = await bcrypt.hash(adminPassword, 10);
            const userRes = await client.query(
                `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif)
                 VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id, nom_complet, email, secteur_id, tenant_id`,
                [tenantId, adminNomComplet.trim(), adminEmail.trim().toLowerCase(), hash, roleRes.rows[0].id]
            );
            const utilisateur = userRes.rows[0];

            await logAudit(client, {
                table: 'organisations',
                rowId: tenantId,
                action: 'CREATE',
                userId: utilisateur.id,
                tenantId,
                details: { nomFerme: nomFerme.trim(), secteurs: secteurs.map((s) => s.nom.trim()) },
            });

            await client.query('COMMIT');

            const token = signToken({ ...utilisateur, role_nom: 'admin' });
            res.status(201).json({
                token,
                utilisateur: {
                    id: utilisateur.id,
                    nom_complet: utilisateur.nom_complet,
                    email: utilisateur.email,
                    role: 'admin',
                    secteur_id: utilisateur.secteur_id,
                    tenant_id: utilisateur.tenant_id,
                },
            });
        } catch (err) {
            await client.query('ROLLBACK');
            if (err.code === '23505') {
                // contrainte unique violée (utilisateurs.email) — jamais tenant_id, qui n'a pas de
                // contrainte unique propre.
                return res.status(409).json({ erreur: 'Cette adresse email est déjà utilisée.' });
            }
            console.error(err);
            res.status(500).json({ erreur: "Erreur lors de la création de la ferme." });
        } finally {
            client.release();
        }
    });

    return router;
};

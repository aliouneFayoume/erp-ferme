const express = require('express');
const bcrypt = require('bcryptjs');
const { signToken, requireAuth } = require('../auth');
const { logAudit } = require('../audit');

module.exports = function authRoutes(pool) {
    const router = express.Router();

    router.post('/login', async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ erreur: 'Email et mot de passe requis.' });
        }

        try {
            const result = await pool.query(
                `SELECT u.id, u.nom_complet, u.email, u.mot_de_passe_hash, u.secteur_id, u.actif, r.nom as role_nom
                 FROM utilisateurs u JOIN roles r ON u.role_id = r.id
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

            const token = signToken(user);
            await logAudit(pool, { table: 'utilisateurs', rowId: user.id, action: 'LOGIN', userId: user.id });

            res.json({
                token,
                utilisateur: {
                    id: user.id,
                    nom_complet: user.nom_complet,
                    email: user.email,
                    role: user.role_nom,
                    secteur_id: user.secteur_id,
                },
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la connexion.' });
        }
    });

    router.get('/me', requireAuth, (req, res) => {
        res.json({ utilisateur: req.user });
    });

    return router;
};

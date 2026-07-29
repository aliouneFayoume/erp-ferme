const jwt = require('jsonwebtoken');

// La présence de DATABASE_URL signale un déploiement réel (par opposition à la simulation locale
// pg-mem) : dans ce cas, un secret par défaut connu de tous permettrait à quiconque de forger un
// token admin valide, donc on refuse de démarrer plutôt que de l'utiliser silencieusement.
if (!process.env.JWT_SECRET && process.env.DATABASE_URL) {
    throw new Error(
        'JWT_SECRET doit être défini explicitement dès qu\'une vraie base de données (DATABASE_URL) est configurée.'
    );
}
if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET non défini : secret de démonstration utilisé (pg-mem uniquement, jamais en production).');
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-simulation-ferme-massla';

function signToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role_nom, nom: user.nom_complet, secteur_id: user.secteur_id },
        JWT_SECRET,
        { expiresIn: '12h' }
    );
}

/**
 * Token du portail client — structurellement distinct d'un token staff (pas de `role`, donc
 * `checkRole` le rejette déjà par défaut) et volontairement plus longue durée : un client ne doit
 * pas avoir à ressaisir son code toutes les 12h comme le staff.
 */
function signClientToken(client) {
    return jwt.sign({ clientId: client.id, pinVersion: client.pin_version, scope: 'portail_client' }, JWT_SECRET, {
        expiresIn: '7d',
    });
}

/**
 * Authentification portail client. Revérifie `pin_version` en base à chaque requête (coût
 * négligeable à cette échelle) : régénérer le code d'un client invalide instantanément toute
 * session déjà émise, sans quoi un JWT volé resterait valable jusqu'à 7 jours malgré la régénération.
 */
function requireClientAuth(pool) {
    return async (req, res, next) => {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) {
            return res.status(401).json({ erreur: 'Non authentifié (token manquant)' });
        }
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            if (payload.scope !== 'portail_client') {
                return res.status(401).json({ erreur: 'Session invalide.' });
            }
            const result = await pool.query(`SELECT id, pin_version FROM clients WHERE id = $1 AND deleted_at IS NULL`, [
                payload.clientId,
            ]);
            const client = result.rows[0];
            if (!client || client.pin_version !== payload.pinVersion) {
                return res.status(401).json({ erreur: 'Session invalide ou expirée' });
            }
            req.client = { id: client.id };
            next();
        } catch (err) {
            return res.status(401).json({ erreur: 'Session invalide ou expirée' });
        }
    };
}

/** Authentification par JWT (Authorization: Bearer <token>) */
function requireAuth(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ erreur: 'Non authentifié (token manquant)' });
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ erreur: 'Session invalide ou expirée' });
    }
}

/** RBAC : restreint l'accès à une liste de rôles. 'admin' passe toujours. */
function checkRole(rolesAutorises) {
    return (req, res, next) => {
        const userRole = req.user?.role;
        if (!userRole) {
            return res.status(401).json({ erreur: 'Non authentifié (rôle manquant)' });
        }
        if (userRole === 'admin' || rolesAutorises.includes(userRole)) {
            next();
        } else {
            res.status(403).json({ erreur: 'Accès refusé. Privilèges insuffisants.' });
        }
    };
}

module.exports = { signToken, requireAuth, checkRole, signClientToken, requireClientAuth, JWT_SECRET };

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
        {
            id: user.id,
            role: user.role_nom,
            nom: user.nom_complet,
            secteur_id: user.secteur_id,
            tenant_id: user.tenant_id,
            // Vue plateforme (routes/plateforme.js) : indépendant du rôle, réservé à un seul compte
            // en pratique — voir migration-04-superviseur-plateforme.sql.
            superviseurPlateforme: !!user.est_superviseur_plateforme,
        },
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
 * Pose le tenant courant sur une connexion dédiée (`req.db`) pour la durée de la requête, afin que
 * les policies RLS (`SELECT ... USING (tenant_id = current_setting('app.current_tenant_id', ...))`,
 * voir rls-policies.sql) filtrent réellement les lignes côté PostgreSQL, en plus du filtrage
 * applicatif déjà présent dans chaque requête. `SET LOCAL` exigerait une transaction explicite
 * autour de chaque requête ; `set_config(..., false)` (portée session) sur une connexion dédiée au
 * temps de la requête HTTP est plus simple et tout aussi étanche tant que la connexion est bien
 * relâchée (et son contexte réinitialisé) à la fin — d'où l'écoute sur 'finish' ET 'close' pour ne
 * jamais laisser une connexion fuiter si la réponse ne se termine pas normalement.
 */
async function attachTenantConnection(req, res, pool, tenantId) {
    req.db = await pool.connect();
    await req.db.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        req.db
            .query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)")
            .catch(() => {})
            .finally(() => req.db.release());
    };
    res.on('finish', release);
    res.on('close', release);
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
            // Lecture pré-tenant (le tenant n'est pas encore connu avant cette ligne) : policy RLS
            // dédiée sur `clients` qui autorise ce cas précis, voir rls-policies.sql.
            const result = await pool.query(`SELECT id, tenant_id, pin_version FROM clients WHERE id = $1 AND deleted_at IS NULL`, [
                payload.clientId,
            ]);
            const client = result.rows[0];
            if (!client || client.pin_version !== payload.pinVersion) {
                return res.status(401).json({ erreur: 'Session invalide ou expirée' });
            }
            req.client = { id: client.id, tenant_id: client.tenant_id };
            await attachTenantConnection(req, res, pool, client.tenant_id);
            next();
        } catch (err) {
            return res.status(401).json({ erreur: 'Session invalide ou expirée' });
        }
    };
}

/** Authentification par JWT (Authorization: Bearer <token>) */
function requireAuth(pool) {
    return async (req, res, next) => {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;

        if (!token) {
            return res.status(401).json({ erreur: 'Non authentifié (token manquant)' });
        }

        try {
            req.user = jwt.verify(token, JWT_SECRET);
            await attachTenantConnection(req, res, pool, req.user.tenant_id);
            next();
        } catch (err) {
            return res.status(401).json({ erreur: 'Session invalide ou expirée' });
        }
    };
}

/**
 * Réservé à la vue plateforme (routes/plateforme.js) : à utiliser APRÈS requireAuth (a besoin de
 * req.user et req.db déjà posés). Pose `app.is_plateforme_admin` sur la connexion déjà attachée à
 * la requête pour que les policies RLS avec échappatoire (voir `is_plateforme_admin()` dans
 * rls-policies.sql) laissent passer une lecture cross-tenant — en LECTURE SEULE : aucune policy
 * d'écriture n'a cette échappatoire, une organisation ne peut jamais être modifiée depuis ici.
 */
function requireSuperviseurPlateforme(req, res, next) {
    if (!req.user?.superviseurPlateforme) {
        return res.status(403).json({ erreur: 'Accès réservé à la supervision plateforme.' });
    }
    req.db
        .query("SELECT set_config('app.is_plateforme_admin', 'true', false)")
        .then(() => next())
        .catch((err) => {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur interne.' });
        });
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

module.exports = {
    signToken,
    requireAuth,
    checkRole,
    signClientToken,
    requireClientAuth,
    attachTenantConnection,
    requireSuperviseurPlateforme,
    JWT_SECRET,
};

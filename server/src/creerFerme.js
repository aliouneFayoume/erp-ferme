const bcrypt = require('bcryptjs');
const { logAudit } = require('./audit');
const { genererSlugUnique } = require('./slug');

/**
 * Crée une nouvelle organisation (ferme cliente) + ses secteurs + son premier compte admin, dans
 * une transaction — cœur partagé entre l'inscription self-service (routes/inscription.js, avec code
 * d'invitation) et la création directe depuis la vue plateforme (routes/plateforme.js, réservée au
 * superviseur, sans code puisque déjà authentifié).
 *
 * Le contexte RLS (tenant_id) est posé juste après la création de l'organisation, sur la même
 * connexion, pour que les insertions suivantes (secteurs, utilisateurs, audit) passent la policy
 * stricte de ces tables sans avoir besoin d'échappatoire dédiée — seule `organisations` a une policy
 * INSERT permissive (voir rls-policies.sql), puisqu'on ne peut par définition pas connaître l'id
 * d'une organisation avant de l'avoir créée.
 *
 * `auditUserId` : qui apparaît comme auteur dans le journal d'audit — le nouvel admin lui-même pour
 * une inscription self-service (personne d'autre n'a agi), ou le superviseur pour une création
 * directe depuis la vue plateforme (c'est lui qui a effectivement cliqué "créer").
 */
async function creerNouvelleFerme(pool, { nomFerme, secteurs, adminNomComplet, adminEmail, adminPassword, auditUserId }) {
    if (!nomFerme || !nomFerme.trim()) {
        throw { statut: 400, message: 'Le nom de la ferme est requis.' };
    }
    if (!Array.isArray(secteurs) || secteurs.length === 0 || secteurs.some((s) => !s.nom || !s.nom.trim())) {
        throw { statut: 400, message: "Au moins un secteur d'activité valide est requis." };
    }
    if (!adminNomComplet || !adminEmail || !adminPassword) {
        throw { statut: 400, message: "Nom, email et mot de passe de l'administrateur sont requis." };
    }
    if (adminPassword.length < 8) {
        throw { statut: 400, message: 'Le mot de passe doit contenir au moins 8 caractères.' };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Généré AVANT de poser is_plateforme_admin : une connexion fraîchement sortie du pool n'a
        // par convention aucun contexte posé (voir le `finally` plus bas et attachTenantConnection,
        // auth.js, qui remettent toujours '' avant de relâcher), donc current_tenant_id() est déjà
        // NULL ici et la policy SELECT de organisations laisse passer cette vérification d'unicité
        // via son échappatoire pré-tenant (voir rls-policies.sql) sans avoir besoin d'échappatoire
        // supplémentaire.
        const slug = await genererSlugUnique(client, nomFerme.trim());

        // `INSERT ... RETURNING` exige EN PLUS que la ligne insérée passe la policy SELECT, pas
        // seulement le WITH CHECK de l'INSERT (piège déjà rencontré pour audit_logs, voir
        // rls-policies.sql) — et à cet instant précis, aucun tenant_id n'existe encore à poser en
        // contexte. Créer une organisation est par nature une opération non scopée à un tenant
        // existant ; poser is_plateforme_admin ici, sur cette connexion dédiée et de courte durée,
        // est le même échappatoire déjà utilisé pour la vue plateforme — sans risque puisque cette
        // connexion ne sert jamais à rien d'autre, et son contexte est remis à zéro avant d'être
        // relâchée vers le pool (voir le `finally` plus bas).
        await client.query("SELECT set_config('app.is_plateforme_admin', 'true', false)");

        const orgRes = await client.query(`INSERT INTO organisations (nom, slug) VALUES ($1, $2) RETURNING id`, [nomFerme.trim(), slug]);
        const tenantId = orgRes.rows[0].id;

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
        const admin = userRes.rows[0];

        await logAudit(client, {
            table: 'organisations',
            rowId: tenantId,
            action: 'CREATE',
            userId: auditUserId ?? admin.id,
            tenantId,
            details: { nomFerme: nomFerme.trim(), secteurs: secteurs.map((s) => s.nom.trim()) },
        });

        await client.query('COMMIT');
        return { tenantId, admin, nomFerme: nomFerme.trim(), slug };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        // Cette connexion retourne au pool et sera réutilisée par une requête sans rapport — jamais
        // la laisser repartir avec un tenant_id ou un is_plateforme_admin résiduel (voir le
        // commentaire équivalent dans attachTenantConnection, auth.js).
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)").catch(() => {});
        client.release();
    }
}

module.exports = { creerNouvelleFerme };

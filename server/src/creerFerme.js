const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { logAudit } = require('./audit');
const { genererSlugUnique } = require('./slug');
const { nomSecteurValide, motDePasseValide, motDePasseErreurs } = require('./validation');
const email = require('./email');

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
    // Audit sécurité 2026-08-11 (M2) : le nom de secteur était entièrement libre et affiché sans
    // échappement à deux endroits du frontend (corrigé le même jour) — restreindre le format ici
    // retire la possibilité même d'y injecter des caractères dangereux, en défense en profondeur.
    if (secteurs.some((s) => !nomSecteurValide(s.nom.trim()))) {
        throw { statut: 400, message: 'Les noms de secteur ne peuvent contenir que lettres, chiffres, espaces et tirets (50 caractères max).' };
    }
    if (!adminNomComplet || !adminEmail || !adminPassword) {
        throw { statut: 400, message: "Nom, email et mot de passe de l'administrateur sont requis." };
    }
    if (!motDePasseValide(adminPassword)) {
        throw { statut: 400, message: `Le mot de passe doit contenir ${motDePasseErreurs(adminPassword).join(', ')}.` };
    }
    // Durcissement sécurité (migration-20) : la vérification d'email est bloquante pour tout
    // nouveau compte — créer un admin sans pouvoir lui envoyer le lien de vérification le
    // laisserait verrouillé hors de son propre compte fraîchement créé. Échec net et explicite
    // plutôt qu'un compte silencieusement invérifiable (même philosophie que whatsapp.js).
    if (!email.estConfigure()) {
        throw { statut: 503, message: 'Vérification email indisponible pour le moment. Contactez le support.' };
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Posé AVANT toute lecture/écriture sur cette connexion, PAS après : une connexion tout
        // juste sortie de `pool.connect()` n'est PAS garantie d'avoir un contexte vide par défaut —
        // constaté en production (2026-08-09, voir le commentaire de queryPreTenant dans auth.js)
        // qu'un `app.current_tenant_id` résiduel peut persister sur une connexion du pool. Poser
        // explicitement is_plateforme_admin ici couvre à la fois la vérification d'unicité du slug
        // ci-dessous ET l'INSERT + RETURNING qui suit (qui en a besoin de toute façon, voir plus bas)
        // — sans dépendre d'une hypothèse sur l'état de current_tenant_id(). Créer une organisation
        // est par nature une opération non scopée à un tenant existant ; cette connexion ne sert
        // jamais à rien d'autre, et son contexte est remis à zéro avant d'être relâchée vers le pool
        // (voir le `finally` plus bas).
        await client.query("SELECT set_config('app.is_plateforme_admin', 'true', false)");

        const slug = await genererSlugUnique(client, nomFerme.trim());

        // `INSERT ... RETURNING` exige EN PLUS que la ligne insérée passe la policy SELECT, pas
        // seulement le WITH CHECK de l'INSERT (piège déjà rencontré pour audit_logs, voir
        // rls-policies.sql) — is_plateforme_admin (posé plus haut) couvre aussi ce cas.
        const orgRes = await client.query(`INSERT INTO organisations (nom, slug) VALUES ($1, $2) RETURNING id`, [nomFerme.trim(), slug]);
        const tenantId = orgRes.rows[0].id;

        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);

        for (const s of secteurs) {
            await client.query(`INSERT INTO secteurs (tenant_id, nom, suivi_recolte, suivi_individuel) VALUES ($1, $2, $3, $4)`, [
                tenantId,
                s.nom.trim(),
                !!s.suiviRecolte,
                !!s.suiviIndividuel,
            ]);
        }

        const roleRes = await client.query(`SELECT id FROM roles WHERE nom = 'admin'`);
        if (roleRes.rows.length === 0) throw new Error("Rôle 'admin' introuvable — la base n'est pas correctement initialisée.");

        const hash = await bcrypt.hash(adminPassword, 10);
        // Durcissement sécurité (migration-20) : cette fonction ne crée que des admins (premier
        // compte d'une nouvelle organisation) — email_verifie=FALSE et mfa_obligatoire=TRUE sont
        // donc posés inconditionnellement ici, jamais hérités d'un défaut de colonne. Token de
        // vérification en clair envoyé par email, seul son hash SHA-256 est stocké (voir email.js).
        const tokenVerification = crypto.randomBytes(32).toString('hex');
        const tokenVerificationHash = crypto.createHash('sha256').update(tokenVerification).digest('hex');
        const userRes = await client.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif,
                                        email_verifie, email_verification_token_hash, email_verification_expire_le, mfa_obligatoire)
             VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, now() + interval '24 hours', TRUE)
             RETURNING id, nom_complet, email, secteur_id, tenant_id, token_version`,
            [tenantId, adminNomComplet.trim(), adminEmail.trim().toLowerCase(), hash, roleRes.rows[0].id, tokenVerificationHash]
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

        // Envoi APRÈS le COMMIT (jamais dans la transaction — appel HTTP externe). Échec non
        // bloquant : l'organisation et l'admin existent déjà, l'utilisateur pourra toujours
        // redemander un email via POST /auth/renvoyer-verification.
        try {
            await email.envoyerEmailVerification(admin.email, admin.nom_complet, tokenVerification);
        } catch (err) {
            console.error("Échec de l'envoi de l'email de vérification lors de la création de la ferme :", err);
        }

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

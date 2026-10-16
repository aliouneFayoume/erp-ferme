const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { logAudit } = require('./audit');
const { genererSlugUnique } = require('./slug');
const { DUREE_ESSAI_JOURS } = require('./modulesSaas');

const JOUR_MS = 24 * 3600 * 1000;

/** Date au format AAAA-MM-JJ, `joursAvant` jours avant aujourd'hui (UTC, comme le reste des saisies de date). */
function dateIlYa(joursAvant, maintenant = new Date()) {
    return new Date(maintenant.getTime() - joursAvant * JOUR_MS).toISOString().slice(0, 10);
}

// Courbe d'un lot de poulets de chair de 42 jours (valeurs réalistes, déterministes : la démo doit être identique à chaque
// ouverture d'essai, sans hasard). Mortalité surtout la première semaine ; consommation en g/poulet/jour ; poids pesé
// chaque semaine (g).
const DUREE_LOT_DEMO_JOURS = 42;
const MORTALITE_SEMAINE_1 = [10, 8, 7, 6, 5, 4, 3];
const POIDS_PESEES_G = { 1: 45, 7: 180, 14: 450, 21: 900, 28: 1450, 35: 2000, 42: 2450 };

function consommationGParPoulet(jour) {
    // 15 g le premier jour jusqu'à ~190 g le dernier, croissance quasi linéaire
    return Math.round(15 + ((jour - 1) * (190 - 15)) / (DUREE_LOT_DEMO_JOURS - 1));
}

/**
 * Remplit la « Ferme démo — 2 000 poulets, lot n°12 » : un lot TERMINÉ (il n'entre donc ni dans la limite « 1 lot en cours »
 * de l'essai, ni dans les statistiques des lots actifs) avec 42 jours de relevés (mortalité, aliment, pesées). Marqué
 * est_demo pour s'afficher « Démo » et se supprimer en un clic. Ne crée volontairement ni ventes ni bilan : ils n'existent pas
 * encore dans l'application (voir le dossier Easystart, phase 4) — on ne montre pas une fonction qui n'existe pas.
 * Doit tourner sur la connexion de la transaction de création, contexte tenant déjà posé (RLS).
 */
async function semerFermeDemo(client, { tenantId, secteurId, utilisateurId, maintenant = new Date() }) {
    const effectifInitial = 2000;
    const debutIlYa = DUREE_LOT_DEMO_JOURS + 7; // lot terminé depuis une semaine
    const lotRes = await client.query(
        `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, est_demo, cree_par)
         VALUES ($1, $2, $3, $4, $5, 'TERMINE', TRUE, $6) RETURNING id`,
        [tenantId, secteurId, 'Lot n°12 (démo)', effectifInitial, dateIlYa(debutIlYa, maintenant), utilisateurId]
    );
    const lotId = lotRes.rows[0].id;

    let vivants = effectifInitial;
    for (let jour = 1; jour <= DUREE_LOT_DEMO_JOURS; jour += 1) {
        const mortalite = jour <= 7 ? MORTALITE_SEMAINE_1[jour - 1] : jour % 2 === 0 ? 1 : 0;
        vivants -= mortalite;
        const alimentKg = Math.round((vivants * consommationGParPoulet(jour)) / 1000);
        await client.query(
            `INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, est_synchronise)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
            [lotId, utilisateurId, dateIlYa(debutIlYa - (jour - 1), maintenant), mortalite, alimentKg, POIDS_PESEES_G[jour] || 0]
        );
    }
    return lotId;
}

/**
 * Crée une ferme d'ESSAI : organisation + abonnement ESSAI de 30 jours + secteur Avicole + un seul compte (le gérant, qui
 * s'identifie par son numéro WhatsApp : pas d'e-mail, mot de passe inutilisable) + la ferme démo. Une transaction.
 *
 * Choix de sécurité assumés (voir aussi migration-35) :
 * - mot_de_passe_hash = empreinte d'un secret aléatoire jeté : la connexion par mot de passe ne peut jamais aboutir pour ce
 *   compte, seul le code WhatsApp ouvre une session ;
 * - mfa_obligatoire = FALSE : le code WhatsApp EST l'unique facteur de ces comptes ; l'imposer en plus enverrait le gérant vers
 *   la configuration d'une application d'authentification, à l'opposé de « rien d'autre que téléphone et nom de ferme » ;
 * - email_verifie reste FALSE : il n'y a pas d'e-mail à vérifier, et aucun parcours ne permet d'en ajouter un sans vérification ;
 * - le numéro est enregistré non vérifié (telephone_verifie = FALSE) tant que le premier code n'a pas été saisi.
 */
async function creerFermeEssai(pool, { nomFerme, telephone, source }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Même amorce que creerFerme.js : contexte explicite avant toute lecture/écriture sur cette connexion, créer une
        // organisation n'étant par nature rattaché à aucun tenant existant.
        await client.query("SELECT set_config('app.is_plateforme_admin', 'true', false)");

        const slug = await genererSlugUnique(client, nomFerme);
        const orgRes = await client.query(`INSERT INTO organisations (nom, slug) VALUES ($1, $2) RETURNING id`, [nomFerme, slug]);
        const tenantId = orgRes.rows[0].id;
        await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);

        const secteurRes = await client.query(
            `INSERT INTO secteurs (tenant_id, nom, suivi_recolte, suivi_individuel) VALUES ($1, 'Avicole', FALSE, FALSE) RETURNING id`,
            [tenantId]
        );
        const secteurId = secteurRes.rows[0].id;

        const roleRes = await client.query(`SELECT id FROM roles WHERE nom = 'admin'`);
        if (roleRes.rows.length === 0) throw new Error("Rôle 'admin' introuvable — la base n'est pas correctement initialisée.");

        const hashInutilisable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
        const userRes = await client.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, actif,
                                        telephone, telephone_verifie, email_verifie, mfa_obligatoire)
             VALUES ($1, 'Gérant', NULL, $2, $3, TRUE, $4, FALSE, FALSE, FALSE)
             RETURNING id, nom_complet, email, secteur_id, tenant_id, token_version`,
            [tenantId, hashInutilisable, roleRes.rows[0].id, telephone]
        );
        const admin = userRes.rows[0];

        const maintenant = new Date();
        await client.query(
            `INSERT INTO organisation_abonnement_saas
               (tenant_id, modules_actifs, montant_mensuel, actif, telephone_contact, plan, essai_debut_le, essai_fin_le, source_inscription)
             VALUES ($1, '{}', 0, TRUE, $2, 'ESSAI', $3, $4, $5)`,
            [tenantId, telephone, maintenant, new Date(maintenant.getTime() + DUREE_ESSAI_JOURS * JOUR_MS), source === 'demo' ? 'demo' : 'essai']
        );

        await semerFermeDemo(client, { tenantId, secteurId, utilisateurId: admin.id, maintenant });

        await logAudit(client, {
            table: 'organisations',
            rowId: tenantId,
            action: 'CREATE',
            userId: admin.id,
            tenantId,
            details: { nomFerme, origine: 'essai_autonome', source: source === 'demo' ? 'demo' : 'essai' },
        });

        await client.query('COMMIT');
        return { tenantId, admin, nomFerme, slug };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)").catch(() => {});
        client.release();
    }
}

module.exports = { creerFermeEssai, semerFermeDemo, DUREE_LOT_DEMO_JOURS };

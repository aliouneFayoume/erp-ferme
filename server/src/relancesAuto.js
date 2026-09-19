// Relance WhatsApp automatique des factures clients impayées, 7 jours après la date d'échéance.
// Jusqu'ici la relance n'existait qu'en manuel (bouton "Rappel WhatsApp", routes/finance.js).
//
// Principes :
// - UNE relance automatique par facture (rappel_auto_envoye_le ne se remet jamais à NULL après un
//   succès) : les relances suivantes restent manuelles, pour ne jamais harceler un client.
// - Envoi idempotent : la facture est "réservée" par un UPDATE conditionnel AVANT l'appel WhatsApp,
//   donc deux balayages simultanés (redémarrage, second processus) ne peuvent pas doubler l'envoi.
//   Si l'envoi échoue, la réservation est levée et rappel_auto_tentatives est incrémenté (plafond).
// - Chaque ferme est traitée dans SON contexte tenant (RLS réelle en production) : aucune requête
//   ne traverse les données d'une autre organisation.
// - Mêmes règles de config que la relance manuelle : Ferme Massla (est_plateforme) utilise les
//   identifiants globaux ; toute autre ferme doit avoir les siens, sinon elle est simplement ignorée.
const { envoyerMessageWhatsapp, estConfigure: whatsappGlobalConfigure } = require('./whatsapp');
const { getWhatsappConfig } = require('./whatsappConfig');
const { resoudreAcces, moduleAutorise } = require('./modulesSaas');
const { logAudit } = require('./audit');

const JOURS_AVANT_RELANCE = 7;
// Rattrapage si le serveur a été arrêté ou WhatsApp en panne au moment prévu : une facture dont
// l'échéance remonte à plus de 21 jours n'est plus relancée automatiquement (relance tardive et
// hors contexte — mieux vaut un appel du comptable).
const JOURS_RATTRAPAGE_MAX = 21;
const MAX_TENTATIVES = 3;
// Une relance manuelle toute récente (ou déjà faite par le comptable) évite le doublon.
const DELAI_APRES_RELANCE_MANUELLE_JOURS = 3;
const MAX_PAR_FERME_PAR_BALAYAGE = 50;

// Heure d'envoi : un message WhatsApp reçu à 3 h du matin est une mauvaise relance. Sénégal = UTC+0.
const HEURE_DEBUT_ENVOI_UTC = 9;
const HEURE_FIN_ENVOI_UTC = 18;
const INTERVALLE_BALAYAGE_MS = 60 * 60 * 1000;
const DELAI_PREMIER_BALAYAGE_MS = 60 * 1000;

function dansFenetreEnvoi(date = new Date()) {
    const h = date.getUTCHours();
    return h >= HEURE_DEBUT_ENVOI_UTC && h < HEURE_FIN_ENVOI_UTC;
}

/** Date ISO (YYYY-MM-DD, UTC) décalée de `jours` — calculée en JS, pas en SQL (voir routes/finance.js). */
function dateIso(base, jours) {
    return new Date(base.getTime() + jours * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Connexion dédiée avec le contexte tenant posé (et remis à zéro au relâchement). */
async function avecContexteTenant(pool, tenantId, fn) {
    const client = await pool.connect();
    try {
        await client.query(
            "SELECT set_config('app.current_tenant_id', $1, false), set_config('app.is_plateforme_admin', '', false)",
            [String(tenantId)]
        );
        return await fn(client);
    } finally {
        await client
            .query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)")
            .catch(() => {});
        client.release();
    }
}

async function traiterFerme(pool, org, { maintenant, envoyer, globalConfigure }) {
    const bilan = { envoyees: 0, echecs: 0 };
    await avecContexteTenant(pool, org.id, async (db) => {
        // Abonnement lu DANS le contexte de la ferme (organisation_abonnement_saas n'a pas
        // d'échappatoire pré-tenant, voir rls-policies.sql).
        let acces = null;
        if (!org.est_plateforme) {
            const abo = await db.query(`SELECT actif, modules_actifs FROM organisation_abonnement_saas WHERE tenant_id = $1`, [org.id]);
            const ligne = abo.rows[0];
            if (ligne && ligne.actif === false) return; // accès suspendu -> aucune relance en son nom
            acces = resoudreAcces(ligne ? ligne.modules_actifs : undefined);
        }
        if (!moduleAutorise(acces, 'finance', 'POST')) return; // relances WhatsApp = module Finance

        let config;
        if (org.est_plateforme) {
            if (!globalConfigure()) return;
        } else {
            config = await getWhatsappConfig(db, org.id);
            if (!config) return;
        }

        const factures = await db.query(
            `SELECT f.id, f.montant_restant, cl.telephone
             FROM factures f
             JOIN commandes c ON c.id = f.commande_id
             JOIN clients cl ON cl.id = c.client_id
             WHERE f.tenant_id = $1
               AND f.montant_restant > 0
               AND f.statut IN ('A_PAYER', 'EN_RETARD', 'PAYEE_PARTIEL')
               AND f.date_echeance <= $2 AND f.date_echeance >= $3
               AND f.rappel_auto_envoye_le IS NULL
               AND f.rappel_auto_tentatives < $4
               AND (f.dernier_rappel_le IS NULL OR f.dernier_rappel_le < $5)
               AND (c.statut IS NULL OR c.statut <> 'ANNULEE')
               AND cl.deleted_at IS NULL
               AND cl.telephone IS NOT NULL AND cl.telephone <> ''
             ORDER BY f.date_echeance ASC
             LIMIT $6`,
            [
                org.id,
                dateIso(maintenant, -JOURS_AVANT_RELANCE),
                dateIso(maintenant, -JOURS_RATTRAPAGE_MAX),
                MAX_TENTATIVES,
                new Date(maintenant.getTime() - DELAI_APRES_RELANCE_MANUELLE_JOURS * 24 * 3600 * 1000),
                MAX_PAR_FERME_PAR_BALAYAGE,
            ]
        );

        for (const facture of factures.rows) {
            const reservation = await db.query(
                `UPDATE factures SET rappel_auto_envoye_le = $2 WHERE id = $1 AND rappel_auto_envoye_le IS NULL RETURNING id`,
                [facture.id, maintenant]
            );
            if (reservation.rows.length === 0) continue; // un autre balayage l'a déjà prise

            try {
                await envoyer(facture.telephone, { config, montant: facture.montant_restant });
            } catch (err) {
                bilan.echecs += 1;
                console.error(`Relance auto : échec pour la facture ${facture.id} (ferme ${org.id}) : ${err.message}`);
                await db.query(
                    `UPDATE factures SET rappel_auto_envoye_le = NULL, rappel_auto_tentatives = rappel_auto_tentatives + 1 WHERE id = $1`,
                    [facture.id]
                );
                continue;
            }

            bilan.envoyees += 1;
            // Le message est parti : rien de ce qui suit ne doit remettre la facture en file.
            try {
                await db.query(`UPDATE factures SET dernier_rappel_le = $2 WHERE id = $1`, [facture.id, maintenant]);
                await logAudit(db, {
                    table: 'factures',
                    rowId: facture.id,
                    action: 'RAPPEL_WHATSAPP_AUTO',
                    userId: null,
                    tenantId: org.id,
                    details: { montant_restant: facture.montant_restant, telephone: facture.telephone },
                });
            } catch (err) {
                console.error(`Relance auto : envoi réussi mais trace non enregistrée (facture ${facture.id}) : ${err.message}`);
            }
        }
    });
    return bilan;
}

/**
 * Un balayage : relance toutes les factures éligibles de toutes les fermes. `envoyer` et
 * `globalConfigure` sont injectables pour les tests. N'échoue jamais globalement à cause d'une
 * seule ferme : l'erreur est journalisée et la suivante est traitée.
 */
async function lancerRelancesAuto(pool, { maintenant = new Date(), envoyer = envoyerMessageWhatsapp, globalConfigure = whatsappGlobalConfigure } = {}) {
    const total = { fermes: 0, envoyees: 0, echecs: 0 };
    // Pré-tenant : organisations est lisible sans contexte (voir rls-policies.sql), on remet
    // explicitement le contexte à vide comme le fait queryPreTenant (auth.js).
    const client = await pool.connect();
    let orgs;
    try {
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)");
        orgs = await client.query(
            `SELECT id, est_plateforme FROM organisations WHERE deleted_at IS NULL AND relances_auto_actives = TRUE ORDER BY id`
        );
    } finally {
        client.release();
    }

    for (const org of orgs.rows) {
        try {
            const bilan = await traiterFerme(pool, org, { maintenant, envoyer, globalConfigure });
            total.fermes += 1;
            total.envoyees += bilan.envoyees;
            total.echecs += bilan.echecs;
        } catch (err) {
            console.error(`Relance auto : erreur sur la ferme ${org.id} :`, err);
        }
    }
    return total;
}

/**
 * Démarre le balayage périodique (toutes les heures, uniquement entre 9 h et 18 h UTC). Renvoie une
 * fonction d'arrêt. RELANCES_AUTO=off coupe tout sans redéployer.
 */
function demarrerPlanificateur(pool) {
    if (process.env.RELANCES_AUTO === 'off') {
        console.log('Relances automatiques désactivées (RELANCES_AUTO=off).');
        return () => {};
    }
    let enCours = false;
    const balayer = async () => {
        if (enCours || !dansFenetreEnvoi(new Date())) return;
        enCours = true;
        try {
            const bilan = await lancerRelancesAuto(pool);
            if (bilan.envoyees || bilan.echecs) {
                console.log(`Relances automatiques : ${bilan.envoyees} envoyée(s), ${bilan.echecs} échec(s).`);
            }
        } catch (err) {
            console.error('Relances automatiques : balayage échoué :', err);
        } finally {
            enCours = false;
        }
    };
    const minuteur = setInterval(balayer, INTERVALLE_BALAYAGE_MS);
    const premier = setTimeout(balayer, DELAI_PREMIER_BALAYAGE_MS);
    // unref : le planificateur ne doit jamais empêcher l'arrêt propre du processus.
    minuteur.unref();
    premier.unref();
    console.log('Relances automatiques J+7 actives (toutes les heures, 9 h–18 h UTC).');
    return () => {
        clearInterval(minuteur);
        clearTimeout(premier);
    };
}

module.exports = {
    lancerRelancesAuto,
    demarrerPlanificateur,
    dansFenetreEnvoi,
    JOURS_AVANT_RELANCE,
    JOURS_RATTRAPAGE_MAX,
    MAX_TENTATIVES,
};

// Rappel J-3 de fin d'essai gratuit (Easystart, phase 5) : un message WhatsApp, UNE fois, quand il reste 3 jours ou moins.
//   « Votre essai se termine dans N jour(s) — passez en Pro pour garder vos lots illimités. »
// Le bandeau dans l'application (web/js/app.js) dit la même chose ; ce module porte la moitié « WhatsApp ».
//
// Principes (mêmes que relancesAuto.js, pour les mêmes raisons) :
// - FERMÉ par défaut, fail-closed : RAPPEL_FIN_ESSAI_ACTIF=true ET un modèle Meta approuvé (WHATSAPP_TEMPLATE_J3_NOM) ET
//   WhatsApp configuré. Sinon aucun message ne part et aucune connexion à la base n'est ouverte.
// - UN seul rappel par ferme : rappel_fin_essai_envoye_le ne revient jamais à NULL après un succès.
// - Envoi idempotent : la ferme est « réservée » par un UPDATE conditionnel AVANT l'appel WhatsApp, donc deux balayages
//   simultanés (redémarrage, second processus) ne doublent jamais l'envoi. Un échec lève la réservation et compte une
//   tentative (plafond), le balayage suivant réessaie.
// - Destinataire : le numéro du gérant, SEULEMENT s'il a été confirmé par un code reçu sur WhatsApp (telephone_verifie) — on ne
//   relance jamais un numéro saisi mais jamais confirmé.
// - Heures d'envoi : 9 h–18 h UTC (Sénégal = UTC+0), comme les relances de factures.
// - Message de plateforme (Massla écrit à ses futurs clients) : identifiants WhatsApp GLOBAUX, jamais ceux d'une ferme.
const { envoyerMessageWhatsapp, estConfigure: whatsappConfigure } = require('./whatsapp');
const { dansFenetreEnvoi } = require('./relancesAuto');
const { logAudit } = require('./audit');

const JOURS_AVANT_FIN = 3;
const MAX_TENTATIVES = 3;
const MAX_PAR_BALAYAGE = 50;
const JOUR_MS = 24 * 3600 * 1000;
const INTERVALLE_BALAYAGE_MS = 60 * 60 * 1000;
const DELAI_PREMIER_BALAYAGE_MS = 90 * 1000;

function rappelFinEssaiActif() {
    return process.env.RAPPEL_FIN_ESSAI_ACTIF === 'true';
}

/** Modèle Meta du rappel (catégorie Utilitaire) : WHATSAPP_TEMPLATE_J3_NOM / WHATSAPP_TEMPLATE_J3_LANGUE. */
function modeleRappel() {
    return { nom: process.env.WHATSAPP_TEMPLATE_J3_NOM || '', langue: process.env.WHATSAPP_TEMPLATE_J3_LANGUE || 'fr' };
}

function rappelFinEssaiDisponible() {
    return rappelFinEssaiActif() && !!modeleRappel().nom && whatsappConfigure();
}

const CONTEXTE_VIDE = "SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)";

/**
 * Un balayage : envoie le rappel à chaque ferme d'essai confirmée dont la fin tombe dans les 3 prochains jours et qui n'a pas
 * encore été prévenue. `envoyer` et `disponible` sont injectables pour les tests. Une erreur sur une ferme n'arrête jamais les autres.
 * Tourne sur UNE connexion dédiée avec l'échappatoire plateforme levée : l'abonnement SaaS n'est modifiable que par la plateforme
 * (policies RLS), et ce balayage est une action de plateforme, pas d'une ferme.
 */
async function lancerRappelsFinEssai(pool, { maintenant = new Date(), envoyer = envoyerMessageWhatsapp, disponible = rappelFinEssaiDisponible } = {}) {
    const bilan = { envoyes: 0, echecs: 0 };
    if (!disponible()) return bilan;

    const modele = modeleRappel();
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', 'true', false)");
        const limite = new Date(maintenant.getTime() + JOURS_AVANT_FIN * JOUR_MS);
        const candidates = await client.query(
            `SELECT a.tenant_id, a.essai_fin_le, u.telephone
             FROM organisation_abonnement_saas a
             JOIN organisations o ON o.id = a.tenant_id
             JOIN utilisateurs u ON u.tenant_id = a.tenant_id
             WHERE a.plan = 'ESSAI' AND a.actif = TRUE AND a.converti_pro_le IS NULL
               AND a.rappel_fin_essai_envoye_le IS NULL AND a.rappel_fin_essai_tentatives < $1
               AND a.essai_fin_le > $2 AND a.essai_fin_le <= $3
               AND o.deleted_at IS NULL AND o.est_plateforme = FALSE
               AND u.deleted_at IS NULL AND u.actif = TRUE AND u.telephone_verifie = TRUE
             ORDER BY a.essai_fin_le ASC, u.id ASC LIMIT $4`,
            [MAX_TENTATIVES, maintenant, limite, MAX_PAR_BALAYAGE]
        );

        const dejaVues = new Set();
        for (const c of candidates.rows) {
            if (dejaVues.has(c.tenant_id)) continue; // une seule personne prévenue par ferme
            dejaVues.add(c.tenant_id);
            try {
                const reservation = await client.query(
                    `UPDATE organisation_abonnement_saas SET rappel_fin_essai_envoye_le = $2
                     WHERE tenant_id = $1 AND rappel_fin_essai_envoye_le IS NULL RETURNING tenant_id`,
                    [c.tenant_id, maintenant]
                );
                if (reservation.rows.length === 0) continue; // un autre balayage l'a déjà prise

                const jours = Math.max(1, Math.ceil((new Date(c.essai_fin_le).getTime() - maintenant.getTime()) / JOUR_MS));
                try {
                    await envoyer(c.telephone, { modele, composants: [{ type: 'body', parameters: [{ type: 'text', text: String(jours) }] }] });
                    bilan.envoyes += 1;
                    await logAudit(client, { table: 'organisation_abonnement_saas', rowId: c.tenant_id, action: 'UPDATE', tenantId: c.tenant_id, details: { action: 'rappel_fin_essai_envoye', jours } });
                } catch (err) {
                    bilan.echecs += 1;
                    console.error(`Rappel fin d'essai : échec d'envoi (ferme ${c.tenant_id}) :`, err.message);
                    await client.query(
                        `UPDATE organisation_abonnement_saas SET rappel_fin_essai_envoye_le = NULL, rappel_fin_essai_tentatives = rappel_fin_essai_tentatives + 1 WHERE tenant_id = $1`,
                        [c.tenant_id]
                    );
                }
            } catch (err) {
                console.error(`Rappel fin d'essai : erreur sur la ferme ${c.tenant_id} :`, err);
            }
        }
    } finally {
        await client.query(CONTEXTE_VIDE).catch(() => {});
        client.release();
    }
    return bilan;
}

/** Balayage horaire (9 h–18 h UTC). Renvoie une fonction d'arrêt. Ne fait rien tant que le rappel n'est pas disponible. */
function demarrerPlanificateur(pool) {
    let enCours = false;
    const balayer = async () => {
        if (enCours || !rappelFinEssaiDisponible() || !dansFenetreEnvoi(new Date())) return;
        enCours = true;
        try {
            const bilan = await lancerRappelsFinEssai(pool);
            if (bilan.envoyes || bilan.echecs) console.log(`Rappels de fin d'essai : ${bilan.envoyes} envoyé(s), ${bilan.echecs} échec(s).`);
        } catch (err) {
            console.error("Rappels de fin d'essai : balayage échoué :", err);
        } finally {
            enCours = false;
        }
    };
    const minuteur = setInterval(balayer, INTERVALLE_BALAYAGE_MS);
    const premier = setTimeout(balayer, DELAI_PREMIER_BALAYAGE_MS);
    minuteur.unref();
    premier.unref();
    return () => {
        clearInterval(minuteur);
        clearTimeout(premier);
    };
}

module.exports = {
    lancerRappelsFinEssai,
    demarrerPlanificateur,
    rappelFinEssaiActif,
    rappelFinEssaiDisponible,
    modeleRappel,
    JOURS_AVANT_FIN,
    MAX_TENTATIVES,
};

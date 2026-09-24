// Paiement en ligne des factures SaaS (Massla se fait payer par ses fermes via PayDunya).
//
// Deux temps :
//  1. le superviseur génère un lien de paiement (routes/plateforme.js, POST /factures-saas/:id/lien-paiement) ;
//  2. la ferme paie sur la page PayDunya, puis PayDunya appelle l'IPN publique (routes/finance.js,
//     POST /paiements/ipn — la même URL que les paiements des clients des fermes), qui délègue ici quand
//     le token n'est pas celui d'un paiement de ferme.
//
// Même discipline de sécurité que l'IPN des fermes : on ne crédite JAMAIS sur la foi du corps de la
// requête. On retrouve le paiement par token, on interroge PayDunya avec les clés de l'organisation
// ÉMETTRICE (Massla), puis on recoupe montant et référence interne avant de marquer la facture payée.
const { attachTenantConnection, queryPreTenantPlateforme } = require('./auth');
const { logAudit } = require('./audit');
const { confirmerFacture } = require('./paydunya');
const { getPaydunyaConfig } = require('./paymentConfig');

const STATUTS_PAYABLES = ['A_PAYER', 'EN_RETARD'];

/**
 * Traite l'IPN d'un paiement de facture SaaS. Renvoie `true` si le token appartient à un paiement SaaS
 * (la réponse HTTP a alors été envoyée ici), `false` s'il est inconnu (l'appelant répond alors « déjà
 * traité / introuvable » comme avant).
 */
async function traiterIpnSaas(req, res, pool, token) {
    const initial = await queryPreTenantPlateforme(pool, `SELECT emetteur_tenant_id FROM paiements_saas WHERE token = $1`, [token]);
    if (initial.rows.length === 0) return false;
    const emetteurTenantId = initial.rows[0].emetteur_tenant_id;

    // Contexte de l'organisation émettrice (ses clés PayDunya sont lues sous RLS de tenant) + échappatoire
    // plateforme (paiements_saas et factures_saas ne sont accessibles qu'ainsi).
    await attachTenantConnection(req, res, pool, emetteurTenantId);
    await req.db.query("SELECT set_config('app.is_plateforme_admin', 'true', false)");

    const credentials = await getPaydunyaConfig(req.db, emetteurTenantId);
    if (!credentials) {
        console.error(`IPN PayDunya (facture SaaS) reçue pour l'organisation ${emetteurTenantId}, mais aucun identifiant configuré.`);
        res.status(500).json({ erreur: 'Configuration de paiement introuvable pour cette organisation.' });
        return true;
    }

    let confirmation;
    try {
        confirmation = await confirmerFacture(token, credentials);
    } catch (err) {
        console.error('Échec de confirmation PayDunya (IPN facture SaaS):', err.message);
        res.status(502).json({ erreur: 'Impossible de vérifier le paiement auprès de PayDunya.' });
        return true;
    }

    if (confirmation.status !== 'completed') {
        // 200 volontaire : notification reçue et traitée, rien à créditer (pending/cancelled).
        res.status(200).json({ message: `Statut ${confirmation.status} — aucune écriture.` });
        return true;
    }

    const client = req.db;
    try {
        await client.query('BEGIN');

        // FOR UPDATE : une IPN dupliquée (retry légitime de PayDunya) ne peut pas valider deux fois.
        const paiementRes = await client.query(
            `SELECT id, facture_saas_id, tenant_id, montant, reference_interne FROM paiements_saas
             WHERE token = $1 AND statut = 'EN_ATTENTE' FOR UPDATE`,
            [token]
        );
        if (paiementRes.rows.length === 0) {
            await client.query('ROLLBACK');
            res.status(200).json({ message: 'Paiement introuvable ou déjà traité (idempotence).' });
            return true;
        }
        const paiement = paiementRes.rows[0];

        // Vérification croisée : le token authentifie QUELLE facture PayDunya a confirmé, pas que le
        // montant et la référence correspondent à ce qu'on a demandé.
        const montantAttendu = Math.round(Number(paiement.montant));
        const montantRecu = Math.round(Number(confirmation.montant));
        if (montantRecu !== montantAttendu || confirmation.referenceInterne !== paiement.reference_interne) {
            await client.query(`UPDATE paiements_saas SET statut = 'ECHOUE' WHERE id = $1`, [paiement.id]);
            await client.query('COMMIT');
            console.error(
                `IPN PayDunya incohérente pour le paiement SaaS ${paiement.id} (ferme ${paiement.tenant_id}) : ` +
                    `montant attendu ${montantAttendu}, reçu ${montantRecu} ; référence attendue "${paiement.reference_interne}", reçue "${confirmation.referenceInterne}".`
            );
            await logAudit(req.db, {
                req,
                table: 'paiements_saas',
                rowId: paiement.id,
                action: 'ANOMALIE_IPN',
                tenantId: paiement.tenant_id,
                details: { token, montantAttendu, montantRecu, referenceAttendue: paiement.reference_interne, referenceRecue: confirmation.referenceInterne },
            });
            res.status(200).json({ message: 'Notification incohérente avec le paiement attendu — marqué en échec.' });
            return true;
        }

        const factureRes = await client.query(`SELECT id, statut FROM factures_saas WHERE id = $1 FOR UPDATE`, [paiement.facture_saas_id]);
        const facture = factureRes.rows[0];

        if (!facture || !STATUTS_PAYABLES.includes(facture.statut)) {
            // Déjà payée (second lien réglé) ou annulée entre-temps : l'argent est bien arrivé chez PayDunya
            // mais on ne crédite pas deux fois — à rembourser ou à régulariser à la main.
            await client.query(`UPDATE paiements_saas SET statut = 'DOUBLON', date_paiement = CURRENT_TIMESTAMP WHERE id = $1`, [paiement.id]);
            await client.query('COMMIT');
            console.error(`Paiement SaaS ${paiement.id} reçu alors que la facture ${paiement.facture_saas_id} est ${facture?.statut ?? 'introuvable'} : à régulariser.`);
            await logAudit(req.db, {
                req,
                table: 'paiements_saas',
                rowId: paiement.id,
                action: 'ANOMALIE_IPN',
                tenantId: paiement.tenant_id,
                details: { token, motif: 'facture_deja_payee_ou_annulee', statutFacture: facture?.statut ?? null, montant: confirmation.montant },
            });
            res.status(200).json({ message: 'Facture déjà réglée ou annulée — paiement marqué en doublon.' });
            return true;
        }

        await client.query(`UPDATE paiements_saas SET statut = 'VALIDE', date_paiement = CURRENT_TIMESTAMP WHERE id = $1`, [paiement.id]);
        await client.query(
            `UPDATE factures_saas SET statut = 'PAYEE', date_paiement = CURRENT_TIMESTAMP, methode_paiement = 'PAYDUNYA' WHERE id = $1`,
            [paiement.facture_saas_id]
        );
        await client.query('COMMIT');

        await logAudit(req.db, {
            req,
            table: 'factures_saas',
            rowId: paiement.facture_saas_id,
            action: 'UPDATE',
            tenantId: paiement.tenant_id,
            details: { statut: 'PAYEE', methode: 'PAYDUNYA', token, montant: confirmation.montant, provider_reference: confirmation.providerReference },
        });
        res.status(200).json({ message: 'Paiement PayDunya confirmé, facture marquée payée.' });
        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Erreur de traitement IPN PayDunya (facture SaaS):', err.message);
        res.status(500).json({ erreur: 'Erreur interne lors du traitement du paiement.' });
        return true;
    }
}

module.exports = { traiterIpnSaas, STATUTS_PAYABLES };

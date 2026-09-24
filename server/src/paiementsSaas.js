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
const crypto = require('crypto');
const { attachTenantConnection, queryPreTenantPlateforme, JWT_SECRET } = require('./auth');
const { logAudit } = require('./audit');
const { creerFacture, confirmerFacture } = require('./paydunya');
const { getPaydunyaConfig } = require('./paymentConfig');

const STATUTS_PAYABLES = ['A_PAYER', 'EN_RETARD'];
const LIBELLES_TYPE_FACTURE = { CONFIGURATION: 'Mise en route', ABONNEMENT: 'Abonnement' };

// Un checkout PayDunya expire ~30 minutes après sa création (constaté en production, 2026-09-24 : le compteur
// de la page de paiement est ancré à la création, pas à la visite). Le lien envoyé à la ferme n'est donc JAMAIS
// l'adresse PayDunya elle-même mais un lien stable de Massla (/api/payer/<jeton>) qui crée un checkout tout
// frais à l'ouverture. Un checkout déjà créé est repris pendant 10 minutes seulement : la personne qui ouvre le
// lien dispose ainsi d'au moins ~20 minutes pour régler.
const REUTILISATION_CHECKOUT_MS = 10 * 60 * 1000;

const erreurHttp = (statutHttp, message) => Object.assign(new Error(message), { statutHttp });

/**
 * Jeton public d'une facture SaaS : `<id>.<signature HMAC>`. Ne révèle que l'identifiant de la facture (déjà
 * séquentiel) ; la signature empêche d'en forger un pour une autre facture. Clé dérivée du secret JWT avec un
 * préfixe de domaine, jamais le secret brut.
 */
function signature(factureId) {
    const cle = crypto.createHmac('sha256', JWT_SECRET).update('facture-saas-payer-v1').digest();
    return crypto.createHmac('sha256', cle).update(String(factureId)).digest('base64url');
}

function creerJeton(factureId) {
    return `${factureId}.${signature(factureId)}`;
}

/** Renvoie l'identifiant de facture si le jeton est authentique, sinon null. */
function lireJeton(jeton) {
    const m = /^(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(String(jeton || ''));
    if (!m) return null;
    const attendue = Buffer.from(signature(m[1]));
    const recue = Buffer.from(m[2]);
    if (attendue.length !== recue.length || !crypto.timingSafeEqual(attendue, recue)) return null;
    return Number(m[1]);
}

/**
 * Exécute `fn(db)` sur une connexion dédiée portant le contexte de l'organisation ÉMETTRICE (ses clés PayDunya
 * sont lues sous RLS de tenant) ET l'échappatoire plateforme (paiements_saas / factures_saas). Contexte remis à
 * vide après coup, comme queryPreTenant. Pour la route publique, sans utilisateur.
 */
async function avecContexteEmetteur(pool, emetteurTenantId, fn) {
    const client = await pool.connect();
    try {
        await client.query("SELECT set_config('app.current_tenant_id', $1, false), set_config('app.is_plateforme_admin', 'true', false)", [String(emetteurTenantId)]);
        return await fn(client);
    } finally {
        await client.query("SELECT set_config('app.current_tenant_id', '', false), set_config('app.is_plateforme_admin', '', false)").catch(() => {});
        client.release();
    }
}

/** Organisation qui encaisse : celle du compte superviseur plateforme (Massla). */
async function trouverTenantEmetteur(pool) {
    const res = await queryPreTenantPlateforme(
        pool,
        `SELECT tenant_id FROM utilisateurs WHERE est_superviseur_plateforme = TRUE AND actif = TRUE AND deleted_at IS NULL ORDER BY id LIMIT 1`,
        []
    );
    return res.rows[0]?.tenant_id ?? null;
}

async function chargerFactureSaas(db, id) {
    const res = await db.query(
        `SELECT f.id, f.tenant_id, f.type, f.periode, f.montant, f.statut, f.date_echeance, o.nom AS organisation_nom
         FROM factures_saas f JOIN organisations o ON o.id = f.tenant_id WHERE f.id = $1`,
        [id]
    );
    return res.rows[0] || null;
}

/** Une facture peut-elle être réglée en ligne ? Lève une erreur (statutHttp 400) sinon. */
function verifierFacturePayable(facture) {
    if (!STATUTS_PAYABLES.includes(facture.statut)) throw erreurHttp(400, 'Cette facture est déjà payée ou annulée.');
    if (!(Number(facture.montant) > 0)) throw erreurHttp(400, 'Cette facture a un montant nul : rien à payer.');
}

/**
 * Renvoie un checkout PayDunya utilisable pour cette facture (repris s'il a moins de 10 minutes, sinon créé) avec
 * les clés PayDunya de l'organisation émettrice. `db` doit porter le contexte de l'émetteur + plateforme
 * (avecContexteEmetteur). Sans `req` : route publique, aucun utilisateur.
 */
async function obtenirOuCreerCheckout(db, { facture, emetteurTenantId }) {
    verifierFacturePayable(facture);
    const credentials = await getPaydunyaConfig(db, emetteurTenantId);
    if (!credentials) {
        throw erreurHttp(503, 'Aucun compte PayDunya configuré pour Massla (Réglages de la ferme, section Paiement).');
    }

    const existant = await db.query(
        `SELECT token, url_paiement, cree_le FROM paiements_saas WHERE facture_saas_id = $1 AND statut = 'EN_ATTENTE' ORDER BY cree_le DESC, id DESC LIMIT 1`,
        [facture.id]
    );
    const ligne = existant.rows[0];
    if (ligne && Date.now() - new Date(ligne.cree_le).getTime() < REUTILISATION_CHECKOUT_MS) {
        return { url: ligne.url_paiement, token: ligne.token, reutilise: true, mode: credentials.mode };
    }

    const referenceInterne = `saas-${facture.id}-${Date.now()}`;
    const libelle = LIBELLES_TYPE_FACTURE[facture.type] || 'Facture';
    let checkout;
    try {
        checkout = await creerFacture({
            montant: facture.montant,
            description: `Massla — ${libelle} — ${facture.organisation_nom}${facture.periode ? ` (${facture.periode})` : ''}`,
            referenceInterne,
            storeName: 'Massla',
            credentials,
            retourChemin: '/paiement-abonnement-succes.html',
            annulationChemin: '/paiement-abonnement-annule.html',
        });
    } catch (err) {
        console.error('Échec de création du checkout PayDunya (facture SaaS):', err.message);
        throw erreurHttp(502, 'Impossible de contacter PayDunya pour créer le paiement.');
    }

    const insertion = await db.query(
        `INSERT INTO paiements_saas (facture_saas_id, tenant_id, emetteur_tenant_id, montant, token, reference_interne, url_paiement)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [facture.id, facture.tenant_id, emetteurTenantId, Math.round(Number(facture.montant)), checkout.token, referenceInterne, checkout.url]
    );
    await logAudit(db, {
        table: 'paiements_saas',
        rowId: insertion.rows[0].id,
        action: 'CREATE',
        tenantId: facture.tenant_id,
        details: { facture_saas_id: facture.id, montant: facture.montant, mode: credentials.mode },
    });
    return { url: checkout.url, token: checkout.token, reutilise: false, mode: credentials.mode };
}

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

module.exports = {
    traiterIpnSaas,
    STATUTS_PAYABLES,
    creerJeton,
    lireJeton,
    avecContexteEmetteur,
    trouverTenantEmetteur,
    chargerFactureSaas,
    verifierFacturePayable,
    obtenirOuCreerCheckout,
    erreurHttp,
};

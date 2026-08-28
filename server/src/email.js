// Envoi d'email transactionnel via Resend — vérification d'adresse email (migration-20). Même
// philosophie que whatsapp.js/paydunya.js : une intégration non configurée échoue proprement
// (erreur claire) plutôt que d'échouer silencieusement ou de simuler un envoi.
const RESEND_API = 'https://api.resend.com/emails';
// Même raisonnement que whatsapp.js/paydunya.js : pas de timeout par défaut sur fetch, un Resend
// muet bloquerait indéfiniment la requête d'inscription/création d'utilisateur.
const DELAI_MAX_MS = 10000;

function lireConfig() {
    return {
        apiKey: process.env.RESEND_API_KEY,
        // ex: "ERP Ferme Massla <no-reply@massla.sn>" — nécessite un domaine vérifié côté Resend.
        from: process.env.RESEND_FROM_EMAIL,
        baseUrl: process.env.APP_BASE_URL || 'http://localhost:4000',
    };
}

function estConfigure() {
    const { apiKey, from } = lireConfig();
    return !!(apiKey && from);
}

// Audit sécurité 2026-08-27 : nomComplet est fourni par l'utilisateur (inscription self-service,
// ou choisi par un admin à la création d'un tiers) et était interpolé tel quel dans le HTML de
// l'email — un nom contenant du balisage/liens s'affichait sans échappement dans la boîte du
// destinataire, envoyé depuis l'adresse de confiance no-reply@massla.sn (vecteur de phishing
// interne). Échappement minimal (les seuls caractères significatifs en HTML), même liste que
// `esc()` côté frontend (web/js/app.js).
function echapperHtml(valeur) {
    return String(valeur ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function envoyerEmailVerification(email, nomComplet, token) {
    const { apiKey, from, baseUrl } = lireConfig();
    if (!apiKey || !from) {
        throw new Error("Intégration email non configurée (RESEND_API_KEY / RESEND_FROM_EMAIL manquants).");
    }
    const lien = `${baseUrl}/verifier-email.html?token=${encodeURIComponent(token)}`;
    const res = await fetch(RESEND_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(DELAI_MAX_MS),
        body: JSON.stringify({
            from,
            to: [email],
            subject: 'Vérifiez votre adresse email — ERP Ferme',
            html: `<p>Bonjour ${echapperHtml(nomComplet)},</p><p>Cliquez sur ce lien pour activer votre compte : <a href="${lien}">${lien}</a></p><p>Ce lien expire dans 24h.</p>`,
        }),
    });

    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    if (!res.ok) {
        const message = data?.message || `Erreur HTTP ${res.status}`;
        throw new Error(`Échec de l'envoi de l'email de vérification : ${message}`);
    }
    return data;
}

// Relance de facture SaaS par email — alternative à envoyerMessageWhatsapp (routes/plateforme.js)
// tant que le numéro WhatsApp Business de la plateforme reste bloqué (voir mémoire
// erp_ferme_whatsapp_status). Envoyée à tous les admins actifs de la ferme cliente : leur email
// est déjà connu (utilisateurs.email), contrairement au numéro WhatsApp qui doit être saisi à part
// dans organisation_abonnement_saas.telephone_contact.
async function envoyerEmailRappelSaas(emails, { organisationNom, montant, dateEcheance, type }) {
    const { apiKey, from } = lireConfig();
    if (!apiKey || !from) {
        throw new Error("Intégration email non configurée (RESEND_API_KEY / RESEND_FROM_EMAIL manquants).");
    }
    if (!emails || emails.length === 0) {
        throw new Error('Aucun email administrateur trouvé pour cette organisation.');
    }
    const montantFormate = `${Number(montant).toLocaleString('fr-FR')} FCFA`;
    const echeanceFormatee = new Date(dateEcheance).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const libelleType = type === 'CONFIGURATION' ? 'de configuration' : "d'abonnement";
    const res = await fetch(RESEND_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(DELAI_MAX_MS),
        body: JSON.stringify({
            from,
            to: emails,
            subject: `Facture ${libelleType} en attente — ${echapperHtml(organisationNom)}`,
            html: `<p>Bonjour,</p><p>Votre facture ${libelleType} de <strong>${montantFormate}</strong> pour ${echapperHtml(organisationNom)} est à régler (échéance : ${echeanceFormatee}).</p><p>Merci de contacter votre interlocuteur habituel pour effectuer le règlement.</p>`,
        }),
    });

    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        data = null;
    }
    if (!res.ok) {
        const message = data?.message || `Erreur HTTP ${res.status}`;
        throw new Error(`Échec de l'envoi de l'email de rappel : ${message}`);
    }
    return data;
}

module.exports = { envoyerEmailVerification, envoyerEmailRappelSaas, estConfigure };

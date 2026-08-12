// Client PayDunya minimal en fetch natif (Node 20+) plutôt que le SDK officiel npm "paydunya",
// dont les dépendances (superagent ancien) portaient plusieurs vulnérabilités critiques/hautes
// (form-data, qs, debug...) sans correctif non-breaking disponible.
//
// Endpoints/format vérifiés à partir du code source du SDK officiel
// (github.com/paydunyadev/paydunya-node-master), pas seulement de la doc publique.
//
// Chaque organisation est son propre agrégateur PayDunya (ses propres identifiants, son propre
// compte marchand) — ces fonctions ne lisent donc plus de clés depuis process.env, elles prennent
// les identifiants de l'organisation courante en paramètre (voir paymentConfig.js pour comment ils
// sont récupérés/déchiffrés).

// Audit systèmes 2026-08-11 (item #10) : sans ceci, un PayDunya lent ou muet bloquait la requête
// HTTP entrante indéfiniment (aucun timeout par défaut sur fetch) — le client final restait devant
// un écran de paiement qui ne répond jamais, sans même un message d'erreur.
const DELAI_MAX_MS = 15000;

function baseUrl(mode) {
  return (mode || 'test').toLowerCase() === 'live' ? 'https://app.paydunya.com/api/v1' : 'https://app.paydunya.com/sandbox-api/v1';
}

function headers(credentials) {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': credentials.masterKey,
    'PAYDUNYA-PRIVATE-KEY': credentials.privateKey,
    'PAYDUNYA-PUBLIC-KEY': credentials.publicKey,
    'PAYDUNYA-TOKEN': credentials.token,
  };
}

function publicUrl() {
  return process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`;
}

/**
 * Crée une facture de paiement PayDunya (Wave, Orange Money, carte...) et renvoie le token et
 * l'URL de paiement hébergée vers laquelle rediriger le client.
 *
 * `referenceInterne` est renvoyé tel quel dans `custom_data` par l'API de confirmation — il sert
 * de vérification croisée en plus du token lui-même lors du traitement de l'IPN.
 * `credentials` : { mode, masterKey, privateKey, publicKey, token } — identifiants de
 * l'organisation qui initie ce paiement (jamais ceux d'une autre organisation).
 */
async function creerFacture({ montant, description, referenceInterne, storeName, credentials }) {
  const res = await fetch(`${baseUrl(credentials.mode)}/checkout-invoice/create`, {
    method: 'POST',
    headers: headers(credentials),
    signal: AbortSignal.timeout(DELAI_MAX_MS),
    body: JSON.stringify({
      invoice: {
        total_amount: Math.round(Number(montant)),
        description,
      },
      store: { name: storeName || 'Ferme' },
      actions: {
        callback_url: `${publicUrl()}/api/finance/paiements/ipn`,
        return_url: `${publicUrl()}/?paiement=succes`,
        cancel_url: `${publicUrl()}/?paiement=annule`,
      },
      custom_data: { reference_interne: referenceInterne },
    }),
  });

  const data = await res.json();
  if (data.response_code !== '00') {
    throw new Error(data.response_text || 'Échec de la création de la facture PayDunya.');
  }
  return { token: data.token, url: data.response_text };
}

/**
 * Vérifie de façon authentifiée (avec les clés API de l'organisation propriétaire du paiement) le
 * statut réel d'une facture auprès du serveur PayDunya, plutôt que de faire confiance au contenu
 * brut de la notification IPN reçue. Seule une requête portant la bonne clé privée peut obtenir
 * cette réponse : c'est cette authentification qui garantit l'origine de la donnée, indépendamment
 * du corps de l'IPN entrante.
 *
 * Comme l'IPN arrive sans contexte utilisateur/tenant, l'appelant doit d'abord retrouver quelle
 * organisation possède ce paiement (recherche par token, sans filtre tenant, voir finance.js) avant
 * de pouvoir fournir ses `credentials` ici — impossible de vérifier une facture avec les mauvaises clés.
 */
async function confirmerFacture(token, credentials) {
  const res = await fetch(`${baseUrl(credentials.mode)}/checkout-invoice/confirm/${token}`, {
    headers: headers(credentials),
    signal: AbortSignal.timeout(DELAI_MAX_MS),
  });

  const data = await res.json();
  if (data.response_code !== '00') {
    throw new Error(data.response_text || 'Échec de la confirmation PayDunya.');
  }

  return {
    status: data.status, // 'pending' | 'cancelled' | 'completed'
    montant: data.invoice?.total_amount,
    referenceInterne: data.custom_data?.reference_interne,
    providerReference: data.provider_reference,
  };
}

module.exports = { creerFacture, confirmerFacture };

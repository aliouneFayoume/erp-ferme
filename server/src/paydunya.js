// Client PayDunya minimal en fetch natif (Node 20+) plutôt que le SDK officiel npm "paydunya",
// dont les dépendances (superagent ancien) portaient plusieurs vulnérabilités critiques/hautes
// (form-data, qs, debug...) sans correctif non-breaking disponible.
//
// Endpoints/format vérifiés à partir du code source du SDK officiel
// (github.com/paydunyadev/paydunya-node-master), pas seulement de la doc publique.

const BASE_URL =
  (process.env.PAYDUNYA_MODE || 'test').toLowerCase() === 'live'
    ? 'https://app.paydunya.com/api/v1'
    : 'https://app.paydunya.com/sandbox-api/v1';

function headers() {
  return {
    'Content-Type': 'application/json',
    'PAYDUNYA-MASTER-KEY': process.env.PAYDUNYA_MASTER_KEY,
    'PAYDUNYA-PRIVATE-KEY': process.env.PAYDUNYA_PRIVATE_KEY,
    'PAYDUNYA-TOKEN': process.env.PAYDUNYA_TOKEN,
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
 */
async function creerFacture({ montant, description, referenceInterne }) {
  const res = await fetch(`${BASE_URL}/checkout-invoice/create`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      invoice: {
        total_amount: Math.round(Number(montant)),
        description,
      },
      store: { name: 'Ferme Massla' },
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
 * Vérifie de façon authentifiée (avec nos propres clés API) le statut réel d'une facture auprès
 * du serveur PayDunya, plutôt que de faire confiance au contenu brut de la notification IPN
 * reçue. Seule une requête portant notre clé privée peut obtenir cette réponse : c'est cette
 * authentification qui garantit l'origine de la donnée, indépendamment du corps de l'IPN entrante.
 */
async function confirmerFacture(token) {
  const res = await fetch(`${BASE_URL}/checkout-invoice/confirm/${token}`, {
    headers: headers(),
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

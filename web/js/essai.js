// Essai gratuit autonome : numéro WhatsApp + nom de ferme, puis code à 6 chiffres reçu sur WhatsApp (voir routes/essai.js).
// Même stockage de session que la connexion normale (js/api.js : erp_token / erp_user), puis redirection vers l'application.
(function () {
  const etapes = {
    indisponible: document.getElementById('essai-indisponible'),
    numero: document.getElementById('essai-etape-numero'),
    code: document.getElementById('essai-etape-code'),
  };
  let telephone = '';

  function montrer(nom) {
    Object.entries(etapes).forEach(([cle, el]) => el.classList.toggle('hidden', cle !== nom));
  }
  function afficherErreur(id, message) {
    const el = document.getElementById(id);
    el.textContent = message;
    el.classList.remove('hidden');
  }
  function masquerErreur(id) {
    document.getElementById(id).classList.add('hidden');
  }

  async function appeler(chemin, corps) {
    const res = await fetch(`/api/essai${chemin}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.erreur) || 'Erreur. Réessayez dans un instant.');
    return data;
  }

  // Source du suivi (« Essayer gratuitement » ou « Demander ma démo ») : ?source=demo dans le lien, sinon essai.
  const source = new URLSearchParams(window.location.search).get('source') === 'demo' ? 'demo' : 'essai';
  // Filière : ?filiere=piscicole dans le lien (page Pisciculture) pré-coche « Pisciculture » ; le visiteur peut toujours changer.
  const FILIERES = ['avicole', 'piscicole', 'maraicher', 'elevage', 'ostreiculture'];
  const filiereDuLien = new URLSearchParams(window.location.search).get('filiere');
  // Filière « cachée » (ostréiculture, version de test) : affichée seulement si le serveur la propose, ou si le lien la nomme ET que
  // le serveur l'accepte. Les quatre filières habituelles restent toujours affichées, même si cette requête échoue.
  fetch('/api/essai/filieres')
    .then((r) => r.json())
    .then((f) => {
      const visible = (f.publiques || []).includes('ostreiculture') || (filiereDuLien === 'ostreiculture' && (f.acceptees || []).includes('ostreiculture'));
      document.getElementById('choix-ostreiculture').classList.toggle('hidden', !visible);
      if (visible && filiereDuLien === 'ostreiculture') document.querySelector('input[name="filiere"][value="ostreiculture"]').checked = true;
    })
    .catch(() => {});
  if (FILIERES.includes(filiereDuLien) && filiereDuLien !== 'ostreiculture') {
    const radio = document.querySelector(`input[name="filiere"][value="${filiereDuLien}"]`);
    if (radio) radio.checked = true;
  }

  document.getElementById('essai-form-numero').addEventListener('submit', async (e) => {
    e.preventDefault();
    masquerErreur('essai-erreur-numero');
    const form = new FormData(e.target);
    const bouton = e.target.querySelector('button[type="submit"]');
    bouton.disabled = true;
    try {
      telephone = String(form.get('telephone') || '').trim();
      const data = await appeler('/inscription', { nomFerme: form.get('nomFerme'), telephone, source, filiere: FILIERES.includes(form.get('filiere')) ? form.get('filiere') : 'avicole' });
      window.MassiaAnalytics?.track('essai_demarre');
      document.getElementById('essai-message-code').textContent = data.message;
      montrer('code');
    } catch (err) {
      afficherErreur('essai-erreur-numero', err.message);
    } finally {
      bouton.disabled = false;
    }
  });

  document.getElementById('essai-form-code').addEventListener('submit', async (e) => {
    e.preventDefault();
    masquerErreur('essai-erreur-code');
    const form = new FormData(e.target);
    const bouton = e.target.querySelector('button[type="submit"]');
    bouton.disabled = true;
    try {
      const data = await appeler('/verifier', { telephone, code: String(form.get('code') || '').trim() });
      localStorage.setItem('erp_token', data.token);
      localStorage.setItem('erp_user', JSON.stringify(data.utilisateur));
      window.location.href = '/';
    } catch (err) {
      afficherErreur('essai-erreur-code', err.message);
      bouton.disabled = false;
    }
  });

  document.getElementById('essai-renvoyer').addEventListener('click', async (e) => {
    e.preventDefault();
    masquerErreur('essai-erreur-code');
    try {
      const data = await appeler('/code', { telephone });
      document.getElementById('essai-message-code').textContent = data.message;
    } catch (err) {
      afficherErreur('essai-erreur-code', err.message);
    }
  });

  document.getElementById('essai-changer').addEventListener('click', (e) => {
    e.preventDefault();
    montrer('numero');
  });

  fetch('/api/essai/disponible')
    .then((r) => r.json())
    .then((d) => montrer(d.disponible ? 'numero' : 'indisponible'))
    .catch(() => montrer('indisponible'));
})();

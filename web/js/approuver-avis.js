// Page publique liée depuis l'email de notification d'avis (server/src/email.js) — consomme le
// jeton en query string et appelle GET /api/avis/approuver, hors de l'app principale (aucune
// session, même logique que verifier-email.js).
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const el = document.getElementById('approbation-message');

  if (!token) {
    el.textContent = 'Lien invalide.';
    return;
  }

  fetch(`/api/avis/approuver?token=${encodeURIComponent(token)}`)
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      el.textContent = res.ok ? data.message || 'Avis publié.' : data.erreur || 'Lien invalide ou expiré.';
    })
    .catch(() => {
      el.textContent = 'Erreur réseau. Réessayez plus tard.';
    });
})();

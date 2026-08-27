// Page publique liée depuis l'email de vérification (server/src/email.js) — consomme le token en
// query string et appelle GET /api/auth/verifier-email, hors de l'app principale (aucune session).
(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const el = document.getElementById('verif-message');

  if (!token) {
    el.textContent = 'Lien de vérification invalide.';
    return;
  }

  fetch(`/api/auth/verifier-email?token=${encodeURIComponent(token)}`)
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      el.textContent = res.ok ? data.message || 'Adresse email vérifiée.' : data.erreur || 'Lien de vérification invalide ou expiré.';
    })
    .catch(() => {
      el.textContent = 'Erreur réseau. Réessayez plus tard.';
    });
})();

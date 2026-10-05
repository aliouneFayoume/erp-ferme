// Page publique « Mot de passe oublié ? » (mot-de-passe-oublie.html) : demande un lien de réinitialisation par e-mail.
// Appelle POST /api/auth/mot-de-passe-oublie — la réponse est toujours la même, que l'adresse existe ou non.
(function () {
  const form = document.getElementById('form-oubli');
  const champ = document.getElementById('oubli-email');
  const erreur = document.getElementById('oubli-erreur');
  const bouton = document.getElementById('oubli-envoi');
  const confirmation = document.getElementById('oubli-ok');
  const message = document.getElementById('oubli-message');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erreur.classList.add('hidden');
    champ.removeAttribute('aria-invalid');
    const adresse = champ.value.trim();
    if (!adresse || !champ.checkValidity()) {
      erreur.textContent = 'Saisissez une adresse e-mail valide, par exemple prenom@ferme.sn.';
      erreur.classList.remove('hidden');
      champ.setAttribute('aria-invalid', 'true');
      champ.focus();
      return;
    }

    bouton.disabled = true;
    const libelle = bouton.textContent;
    bouton.textContent = 'Envoi…';
    try {
      const res = await fetch('/api/auth/mot-de-passe-oublie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: adresse }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.erreur || "Impossible d'envoyer le lien pour le moment. Réessayez dans quelques minutes.");
      message.textContent = data.message || "Si un compte existe pour cette adresse, un e-mail vient d'être envoyé.";
      form.classList.add('hidden');
      confirmation.classList.remove('hidden');
    } catch (err) {
      erreur.textContent = err.message === 'Failed to fetch' ? 'Pas de connexion. Vérifiez votre réseau et réessayez.' : err.message;
      erreur.classList.remove('hidden');
    } finally {
      bouton.disabled = false;
      bouton.textContent = libelle;
    }
  });
})();

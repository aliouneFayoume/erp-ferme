// Page publique liée depuis l'e-mail de réinitialisation (reinitialiser-mot-de-passe.html) : lit le jeton dans l'adresse
// et appelle POST /api/auth/reinitialiser-mot-de-passe. Aucune session n'existe à ce stade.
(function () {
  const jeton = new URLSearchParams(window.location.search).get('token');
  const form = document.getElementById('form-reinit');
  const champMdp = document.getElementById('reinit-mdp');
  const champConfirmation = document.getElementById('reinit-confirmation');
  const erreur = document.getElementById('reinit-erreur');
  const bouton = document.getElementById('reinit-envoi');
  const intro = document.getElementById('reinit-intro');
  const confirmation = document.getElementById('reinit-ok');
  const lienDemande = document.getElementById('reinit-lien-demande');

  function afficherErreur(texte, champ) {
    erreur.textContent = texte;
    erreur.classList.remove('hidden');
    [champMdp, champConfirmation].forEach((c) => c.removeAttribute('aria-invalid'));
    if (champ) {
      champ.setAttribute('aria-invalid', 'true');
      champ.focus();
    }
  }

  // Lien sans jeton (adresse tronquée par un client mail) : inutile d'afficher un formulaire qui échouera.
  if (!jeton) {
    form.classList.add('hidden');
    intro.textContent = "Ce lien est incomplet. Demandez-en un nouveau : il vous sera envoyé par e-mail.";
    lienDemande.classList.remove('hidden');
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    erreur.classList.add('hidden');
    if (champMdp.value !== champConfirmation.value) {
      afficherErreur('Les deux mots de passe ne sont pas identiques. Saisissez-les à nouveau.', champConfirmation);
      return;
    }

    bouton.disabled = true;
    const libelle = bouton.textContent;
    bouton.textContent = 'Enregistrement…';
    try {
      const res = await fetch('/api/auth/reinitialiser-mot-de-passe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jeton, newPassword: champMdp.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const lienPerime = res.status === 400 && /lien/i.test(data.erreur || '');
        if (lienPerime) lienDemande.classList.remove('hidden');
        throw Object.assign(new Error(data.erreur || 'Impossible de modifier le mot de passe pour le moment.'), { champ: lienPerime ? null : champMdp });
      }
      form.classList.add('hidden');
      intro.classList.add('hidden');
      confirmation.classList.remove('hidden');
    } catch (err) {
      afficherErreur(err.message === 'Failed to fetch' ? 'Pas de connexion. Vérifiez votre réseau et réessayez.' : err.message, err.champ);
    } finally {
      bouton.disabled = false;
      bouton.textContent = libelle;
    }
  });
})();

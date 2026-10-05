// Page « Politique de confidentialité » : affiche le choix de mesure d'audience du visiteur et permet de le changer.
// S'appuie sur window.MassiaAnalytics (js/analytics.js), qui mémorise le choix dans le navigateur.
(function () {
  const etat = document.getElementById('etat-audience');
  const bouton = document.getElementById('btn-audience');
  const analytics = window.MassiaAnalytics;
  if (!etat || !bouton) return;

  if (!analytics || typeof analytics.choix !== 'function') {
    etat.textContent = "Le réglage n'est pas disponible dans ce navigateur. Vous pouvez refuser la mesure d'audience avec le signal « Ne pas me suivre » de votre navigateur.";
    return;
  }

  function afficher(message) {
    const refuse = analytics.choix() === 'refus';
    etat.textContent = message || (refuse ? "Mesure d'audience : désactivée sur ce navigateur." : "Mesure d'audience : activée sur ce navigateur.");
    if (analytics.doNotTrack) {
      etat.textContent = "Votre navigateur envoie le signal « Ne pas me suivre » : la mesure d'audience est désactivée.";
      bouton.hidden = true;
      return;
    }
    bouton.textContent = refuse ? "Autoriser la mesure d'audience" : "Refuser la mesure d'audience";
    bouton.hidden = false;
  }

  bouton.addEventListener('click', () => {
    const etaitRefuse = analytics.choix() === 'refus';
    analytics.definirChoix(etaitRefuse ? 'ok' : 'refus');
    afficher(etaitRefuse ? "Mesure d'audience : activée. Elle reprendra à votre prochaine visite." : "Mesure d'audience : désactivée sur ce navigateur.");
  });

  afficher();
})();

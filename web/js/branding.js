// Image de marque de l'écran de connexion AVANT authentification (staff : index.html, portail :
// portail.html) : si la page est visitée via le sous-domaine d'une ferme (<slug>.massla.sn), affiche
// son nom réel à la place de "Ferme Massla" par défaut. Non-critique — en cas d'échec ou de domaine
// racine, la marque par défaut déjà présente dans le HTML reste inchangée.
(function () {
  fetch('/api/public/organisation')
    .then((res) => (res.ok ? res.json() : { nom: null }))
    .then((data) => {
      if (!data || !data.nom) return;
      document.querySelectorAll('[data-brand]').forEach((el) => {
        el.textContent = data.nom;
      });
      if (document.title.includes('Ferme Massla')) {
        document.title = document.title.replace('Ferme Massla', data.nom);
      }
    })
    .catch(() => {});
})();

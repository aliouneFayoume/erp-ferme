// Image de marque de l'écran de connexion AVANT authentification (staff : index.html, portail :
// portail.html) : si la page est visitée via le sous-domaine d'une ferme (<slug>.massla.sn), affiche
// son nom réel sous le logo Massla (les éléments [data-brand] sont masqués tant qu'aucune ferme n'est identifiée). Non-critique — en cas d'échec ou de domaine
// racine, la marque par défaut déjà présente dans le HTML reste inchangée.
(function () {
  fetch('/api/public/organisation')
    .then((res) => (res.ok ? res.json() : { nom: null }))
    .then((data) => {
      if (!data || !data.nom) return;
      document.querySelectorAll('[data-brand]').forEach((el) => {
        el.textContent = data.nom;
        el.classList.remove('hidden');
      });
      if (document.title.includes('Massla')) {
        document.title = document.title.replace('Massla', data.nom);
      }
    })
    .catch(() => {});
})();

(function () {
  const grid = document.getElementById('avis-grid');
  const overlay = document.getElementById('modal-avis');
  const openBtn = document.getElementById('btn-open-avis-modal');
  const closeBtn = document.getElementById('modal-avis-close');
  const form = document.getElementById('form-avis');
  const errEl = document.getElementById('avis-error');
  const successEl = document.getElementById('avis-success');
  const submitBtn = document.getElementById('avis-submit');

  // Construit chaque carte via des noeuds texte (jamais innerHTML) : commentaire et noms viennent
  // de visiteurs, pas question d'y interpréter du HTML même après validation côté modération.
  function creerCarteAvis(avis) {
    const card = document.createElement('div');
    card.className = 'avis-card';

    const stars = document.createElement('div');
    stars.className = 'avis-stars';
    stars.textContent = '★'.repeat(avis.note) + '☆'.repeat(5 - avis.note);
    card.appendChild(stars);

    const p = document.createElement('p');
    p.textContent = avis.commentaire;
    card.appendChild(p);

    const cite = document.createElement('cite');
    cite.textContent = avis.nom_ferme ? `${avis.nom} — ${avis.nom_ferme}` : avis.nom;
    card.appendChild(cite);

    return card;
  }

  if (grid) {
    fetch('/api/avis')
      .then((res) => (res.ok ? res.json() : []))
      .then((avisList) => {
        if (!Array.isArray(avisList) || avisList.length === 0) return;
        avisList.forEach((avis) => grid.appendChild(creerCarteAvis(avis)));
        grid.hidden = false;
      })
      .catch(() => {});
  }

  if (!overlay || !form) return;

  function ouvrir() {
    form.hidden = false;
    successEl.hidden = true;
    errEl.hidden = true;
    overlay.hidden = false;
    document.getElementById('avis-nom')?.focus();
  }

  function fermer() {
    overlay.hidden = true;
  }

  openBtn?.addEventListener('click', ouvrir);
  closeBtn?.addEventListener('click', fermer);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) fermer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) fermer();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const data = new FormData(form);
    const body = {
      nom: data.get('nom'),
      nomFerme: data.get('nomFerme'),
      note: Number(data.get('note')),
      commentaire: data.get('commentaire'),
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Envoi...';
    try {
      const res = await fetch('/api/avis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.erreur || "Erreur lors de l'envoi.");
      window.MassiaAnalytics?.track('avis_envoye');
      form.reset();
      form.hidden = true;
      successEl.hidden = false;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Envoyer mon avis';
    }
  });
})();

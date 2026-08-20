document.getElementById('inscription-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = new FormData(form);
  const errEl = document.getElementById('inscription-error');
  errEl.classList.add('hidden');

  const secteurs = [];
  if (data.get('secteur-avicole')) secteurs.push({ nom: 'Avicole', suiviRecolte: false });
  if (data.get('secteur-piscicole')) secteurs.push({ nom: 'Piscicole', suiviRecolte: false });
  if (data.get('secteur-maraicher')) secteurs.push({ nom: 'Maraîcher', suiviRecolte: true });
  const autreNom = (data.get('secteurAutreNom') || '').trim();
  if (autreNom) secteurs.push({ nom: autreNom, suiviRecolte: !!data.get('secteurAutreRecolte') });

  if (secteurs.length === 0) {
    errEl.textContent = 'Sélectionnez au moins un secteur d\'activité.';
    errEl.classList.remove('hidden');
    return;
  }

  const body = {
    code: data.get('code'),
    nomFerme: data.get('nomFerme'),
    secteurs,
    adminNomComplet: data.get('adminNomComplet'),
    adminEmail: data.get('adminEmail'),
    adminPassword: data.get('adminPassword'),
  };

  try {
    const res = await fetch('/api/inscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.erreur || 'Erreur lors de la création de la ferme.');
    }
    window.MassiaAnalytics?.track('compte_cree');
    // Connexion automatique : mêmes clés localStorage que l'app principale (js/api.js), qui les
    // relit au chargement de / pour afficher directement le tableau de bord sans repasser par login.
    localStorage.setItem('erp_token', result.token);
    localStorage.setItem('erp_user', JSON.stringify(result.utilisateur));
    window.location.href = '/';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

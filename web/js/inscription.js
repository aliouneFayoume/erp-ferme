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
    // Durcissement sécurité (migration-20) : plus de connexion automatique — le nouvel admin est
    // email_verifie=FALSE côté serveur, une session immédiate contournerait la vérification
    // bloquante. On affiche le message du serveur et on laisse l'utilisateur consulter sa boîte mail.
    form.reset();
    form.classList.add('hidden');
    const succesEl = document.getElementById('inscription-succes');
    succesEl.textContent = result.message || 'Compte créé. Vérifiez votre boîte mail avant de vous connecter.';
    succesEl.classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

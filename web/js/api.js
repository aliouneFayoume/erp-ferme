const Api = (() => {
  function getToken() {
    return localStorage.getItem('erp_token');
  }
  function getUser() {
    const raw = localStorage.getItem('erp_user');
    return raw ? JSON.parse(raw) : null;
  }
  function setSession(token, utilisateur) {
    localStorage.setItem('erp_token', token);
    localStorage.setItem('erp_user', JSON.stringify(utilisateur));
  }
  function clearSession() {
    localStorage.removeItem('erp_token');
    localStorage.removeItem('erp_user');
  }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // fetch() rejette (pas de réseau) — distinct d'une réponse HTTP d'erreur : le formulaire
      // appelant peut choisir de mettre l'action en file d'attente hors-ligne plutôt que l'échouer.
      const erreurReseau = new Error('Pas de connexion réseau.');
      erreurReseau.reseau = true;
      throw erreurReseau;
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      const message = (data && data.erreur) || `Erreur ${res.status}`;
      throw new Error(message);
    }
    return data;
  }

  // Téléchargement d'un fichier protégé (ex. PDF de facture) : un <a href> normal ne peut pas
  // porter l'en-tête Authorization, donc on récupère le fichier en mémoire (Blob) via fetch
  // authentifié, et c'est l'appelant qui déclenche le téléchargement avec un lien blob: temporaire.
  async function getBlob(path) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api${path}`, { headers });
    } catch (err) {
      throw new Error('Pas de connexion réseau.');
    }
    if (!res.ok) {
      let message = `Erreur ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.erreur) message = data.erreur;
      } catch (e) {
        // réponse non-JSON (ex. page d'erreur HTML) : on garde le message par défaut
      }
      throw new Error(message);
    }
    return res.blob();
  }

  return {
    getToken,
    getUser,
    setSession,
    clearSession,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    put: (path, body) => request(path, { method: 'PUT', body }),
    del: (path) => request(path, { method: 'DELETE' }),
    getBlob,
  };
})();

const Api = (() => {
  // Cache de lecture hors-ligne : la dernière réponse réussie de chaque GET est gardée en
  // localStorage pour rester consultable sans réseau (terrain). Les écritures (POST/PUT/DELETE)
  // ne sont jamais servies depuis ce cache — seules les lectures peuvent être "un peu périmées".
  const READ_CACHE_PREFIX = 'erp_api_cache:';
  function cacheGet(path) {
    try {
      const raw = localStorage.getItem(READ_CACHE_PREFIX + path);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function cacheSet(path, data) {
    try {
      localStorage.setItem(READ_CACHE_PREFIX + path, JSON.stringify(data));
    } catch (e) {
      // quota localStorage dépassé ou navigation privée : on continue sans cache, non bloquant
    }
  }
  function clearReadCache() {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(READ_CACHE_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  }

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
    // Évite qu'un autre utilisateur du même appareil consulte hors-ligne les données du compte
    // précédent une fois déconnecté.
    clearReadCache();
    clearSuperviseurSession();
  }

  // Session superviseur mise de côté pendant une impersonation ("Se connecter en tant
  // qu'administrateur" depuis la vue plateforme) — clé distincte de erp_token/erp_user pour pouvoir
  // restaurer la session d'origine sans avoir à se reconnecter. Voir web/js/views/plateforme.js et
  // buildShell() dans app.js.
  function setSuperviseurSession(token, utilisateur) {
    localStorage.setItem('erp_superviseur_token', token);
    localStorage.setItem('erp_superviseur_user', JSON.stringify(utilisateur));
  }
  function getSuperviseurSession() {
    const token = localStorage.getItem('erp_superviseur_token');
    const raw = localStorage.getItem('erp_superviseur_user');
    if (!token || !raw) return null;
    return { token, utilisateur: JSON.parse(raw) };
  }
  function clearSuperviseurSession() {
    localStorage.removeItem('erp_superviseur_token');
    localStorage.removeItem('erp_superviseur_user');
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
      // fetch() rejette (pas de réseau) — distinct d'une réponse HTTP d'erreur. Pour une lecture,
      // on retombe sur la dernière réponse connue plutôt que de bloquer toute consultation
      // terrain sans signal. Pour une écriture, l'appelant peut choisir de la mettre en file
      // d'attente hors-ligne plutôt que de l'échouer (déjà géré dans certains formulaires).
      if (method === 'GET') {
        const cached = cacheGet(path);
        if (cached) {
          window.dispatchEvent(new CustomEvent('erp:offline-read'));
          return cached;
        }
      }
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
      const erreurHttp = new Error(message);
      // Exposé pour OfflineQueue.synchroniser() : distinguer un refus définitif (400/409/422 —
      // "commande déjà annulée") d'une session expirée (401/403) ou d'une panne serveur passagère
      // (5xx), qui ne doivent jamais faire perdre une action en attente. Audit systèmes 2026-08-11.
      erreurHttp.statut = res.status;
      // Code métier optionnel (ex: EMAIL_NON_VERIFIE, MFA_SETUP_REQUIS — voir routes/auth.js) : le
      // message texte peut changer, le code non, donc c'est lui que le frontend doit tester.
      erreurHttp.code = data && data.code;
      throw erreurHttp;
    }

    if (method === 'GET') cacheSet(path, data);
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
    setSuperviseurSession,
    getSuperviseurSession,
    clearSuperviseurSession,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    put: (path, body) => request(path, { method: 'PUT', body }),
    del: (path, body) => request(path, { method: 'DELETE', body }),
    getBlob,
  };
})();

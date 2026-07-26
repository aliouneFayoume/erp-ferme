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

    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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

  return {
    getToken,
    getUser,
    setSession,
    clearSession,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    put: (path, body) => request(path, { method: 'PUT', body }),
    del: (path) => request(path, { method: 'DELETE' }),
  };
})();

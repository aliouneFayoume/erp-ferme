// Portail client — page autonome, volontairement séparée de l'app staff (js/app.js) : jetons de
// session distincts (localStorage différent), pas de PWA/offline, pas de rôles RBAC à gérer.

const PortailApi = (() => {
  function getToken() {
    return localStorage.getItem('portail_token');
  }
  function getClient() {
    const raw = localStorage.getItem('portail_client');
    return raw ? JSON.parse(raw) : null;
  }
  function setSession(token, client) {
    localStorage.setItem('portail_token', token);
    localStorage.setItem('portail_client', JSON.stringify(client));
  }
  function clearSession() {
    localStorage.removeItem('portail_token');
    localStorage.removeItem('portail_client');
  }

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    let res;
    try {
      res = await fetch(`/api/portail${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (err) {
      throw new Error('Pas de connexion réseau.');
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.erreur) || `Erreur ${res.status}`);
    return data;
  }

  async function getBlob(path) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/portail${path}`, { headers });
    } catch (err) {
      throw new Error('Pas de connexion réseau.');
    }
    if (!res.ok) {
      let message = `Erreur ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.erreur) message = data.erreur;
      } catch (e) {}
      throw new Error(message);
    }
    return res.blob();
  }

  return {
    getToken,
    getClient,
    setSession,
    clearSession,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    getBlob,
  };
})();

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function fmt(n) {
  return (Number(n) || 0).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}
function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const STATUT_COMMANDE_BADGE = { EN_ATTENTE: 'warn', PREPAREE: 'info', EN_LIVRAISON: 'info', LIVREE: 'ok', ANNULEE: 'muted' };
const STATUT_FACTURE_LABELS = { A_PAYER: 'À payer', PAYEE_PARTIEL: 'Payée partiellement', PAYEE: 'Payée', EN_RETARD: 'En retard' };
const STATUT_FACTURE_BADGE = { A_PAYER: 'warn', PAYEE_PARTIEL: 'info', PAYEE: 'ok', EN_RETARD: 'danger' };
const STATUT_LIVRAISON_BADGE = { A_FAIRE: 'warn', EN_COURS: 'info', TERMINEE: 'ok', ECHOUEE: 'danger' };
const STATUT_TICKET_LABELS = { OUVERT: 'Ouvert', EN_COURS: 'En cours', RESOLU: 'Résolu', FERME: 'Fermé' };
const STATUT_TICKET_BADGE = { OUVERT: 'warn', EN_COURS: 'info', RESOLU: 'ok', FERME: 'muted' };

const TAB_DEFS = [
  { key: 'commandes', label: 'Commandes' },
  { key: 'factures', label: 'Factures' },
  { key: 'livraisons', label: 'Livraisons' },
  { key: 'tickets', label: 'Mes demandes' },
];

const Views = {
  async commandes(container) {
    const commandes = await PortailApi.get('/commandes');
    container.innerHTML = `
      <div class="panel">
        <h2>Mes commandes (${commandes.length})</h2>
        ${
          commandes.length === 0
            ? '<p class="empty">Aucune commande pour l\'instant.</p>'
            : commandes
                .map(
                  (c) => `<div class="panel" style="margin-bottom:10px;">
                    <p><strong>${esc(c.numero_commande)}</strong> — <span class="badge ${STATUT_COMMANDE_BADGE[c.statut] || 'muted'}">${esc(c.statut)}</span> — ${fmtDate(c.cree_le)}</p>
                    <table>
                      <thead><tr><th>Produit</th><th>Qté</th><th>Sous-total</th></tr></thead>
                      <tbody>
                        ${c.lignes.map((l) => `<tr><td>${esc(l.produit_nom)}</td><td>${l.quantite}</td><td class="num">${fmt(l.sous_total)} FCFA</td></tr>`).join('')}
                      </tbody>
                    </table>
                    <p class="num" style="text-align:right; font-weight:700;">Total : ${fmt(c.montant_total)} FCFA</p>
                  </div>`
                )
                .join('')
        }
      </div>
    `;
  },

  async factures(container) {
    const factures = await PortailApi.get('/factures');
    container.innerHTML = `
      <div class="panel">
        <h2>Mes factures (${factures.length})</h2>
        <table>
          <thead><tr><th>Commande</th><th>Échéance</th><th>Statut</th><th>Restant dû</th><th></th></tr></thead>
          <tbody>
            ${factures
              .map(
                (f) => `<tr>
                  <td>${esc(f.numero_commande)}</td>
                  <td>${fmtDate(f.date_echeance)}</td>
                  <td><span class="badge ${STATUT_FACTURE_BADGE[f.statut] || 'muted'}">${esc(STATUT_FACTURE_LABELS[f.statut] || f.statut)}</span></td>
                  <td class="num">${fmt(f.montant_restant)} FCFA</td>
                  <td><button class="secondary" data-pdf="${f.id}" data-numero="${esc(f.numero_commande)}">PDF</button></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    container.querySelectorAll('button[data-pdf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const blob = await PortailApi.getBlob(`/factures/${btn.dataset.pdf}/pdf`);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `facture-${btn.dataset.numero}.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },

  async livraisons(container) {
    const livraisons = await PortailApi.get('/livraisons');
    container.innerHTML = `
      <div class="panel">
        <h2>Mes livraisons (${livraisons.length})</h2>
        <table>
          <thead><tr><th>Commande</th><th>Date prévue</th><th>Statut</th></tr></thead>
          <tbody>
            ${livraisons
              .map(
                (l) => `<tr>
                  <td>${esc(l.numero_commande)}</td>
                  <td>${fmtDate(l.date_prevue)}</td>
                  <td><span class="badge ${STATUT_LIVRAISON_BADGE[l.statut] || 'muted'}">${esc(l.statut)}</span></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  async tickets(container) {
    const tickets = await PortailApi.get('/tickets');
    container.innerHTML = `
      <div class="panel">
        <h2>Nouvelle demande</h2>
        <form id="form-ticket" class="form-grid">
          <label>Sujet<input type="text" name="sujet" required /></label>
          <label class="span-2">Description<textarea name="description" rows="2"></textarea></label>
          <button type="submit">Envoyer</button>
        </form>
      </div>
      <div class="panel">
        <h2>Mes demandes (${tickets.length})</h2>
        <table>
          <thead><tr><th>Sujet</th><th>Statut</th><th>Créé le</th><th></th></tr></thead>
          <tbody>
            ${tickets
              .map(
                (t) => `<tr>
                  <td>${esc(t.sujet)}</td>
                  <td><span class="badge ${STATUT_TICKET_BADGE[t.statut] || 'muted'}">${esc(STATUT_TICKET_LABELS[t.statut] || t.statut)}</span></td>
                  <td>${fmtDate(t.cree_le)}</td>
                  <td><button class="secondary" data-ouvrir="${t.id}">Ouvrir</button></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#form-ticket').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await PortailApi.post('/tickets', { sujet: fd.get('sujet'), description: fd.get('description') });
        showToast('Demande envoyée.', 'success');
        Views.tickets(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-ouvrir]').forEach((btn) => {
      btn.addEventListener('click', () => ouvrirTicket(container, tickets.find((t) => t.id === Number(btn.dataset.ouvrir))));
    });
  },
};

async function ouvrirTicket(container, ticket) {
  const messages = await PortailApi.get(`/tickets/${ticket.id}/messages`);
  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>${esc(ticket.sujet)}</h3>
        <div class="ticket-thread" style="max-height: 240px; overflow-y: auto; margin: 1rem 0;">
          ${
            messages.length
              ? messages
                  .map(
                    (m) =>
                      `<p><strong>${m.auteur_type === 'client' ? 'Vous' : esc(m.auteur_nom)}</strong> <span class="desc">(${fmtDate(m.cree_le)})</span><br>${esc(m.message)}</p>`
                  )
                  .join('')
              : '<p class="empty">Aucun échange pour l\'instant.</p>'
          }
        </div>
        <form id="form-message" class="form-grid">
          <label class="span-2">Répondre<textarea name="message" rows="2" required></textarea></label>
        </form>
        <div class="modal-actions">
          <button class="secondary" data-action="fermer">Fermer</button>
          <button data-action="envoyer">Envoyer</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);
  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('[data-action="fermer"]').addEventListener('click', closeModal);
  overlay.querySelector('[data-action="envoyer"]').addEventListener('click', async () => {
    const message = overlay.querySelector('textarea[name="message"]').value.trim();
    if (!message) return;
    try {
      await PortailApi.post(`/tickets/${ticket.id}/messages`, { message });
      closeModal();
      Views.tickets(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

let currentTab = null;
async function selectTab(key) {
  currentTab = key;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">Chargement…</div>';
  try {
    await Views[key](view);
  } catch (err) {
    view.innerHTML = `<div class="panel"><p class="login-error">${esc(err.message)}</p></div>`;
  }
}

function buildShell(client) {
  document.getElementById('who-name').textContent = client.nom;
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  TAB_DEFS.forEach((t) => {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    btn.dataset.key = t.key;
    btn.addEventListener('click', () => selectTab(t.key));
    nav.appendChild(btn);
  });
  selectTab(TAB_DEFS[0].key);
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  buildShell(PortailApi.getClient());
}
function showLogin() {
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  try {
    const data = await PortailApi.post('/login', { telephone: form.get('telephone'), pin: form.get('pin') });
    PortailApi.setSession(data.token, data.client);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  PortailApi.clearSession();
  showLogin();
});

(function init() {
  if (PortailApi.getToken() && PortailApi.getClient()) {
    showApp();
  } else {
    showLogin();
  }
})();

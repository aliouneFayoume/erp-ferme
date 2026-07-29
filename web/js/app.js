const Views = window.Views || {};

const TAB_DEFS = [
  { key: 'dashboard', label: 'Tableau de bord', roles: ['admin', 'comptable'] },
  { key: 'production', label: 'Production', roles: ['admin', 'chef_prod'] },
  { key: 'catalogue', label: 'Catalogue & Stock', roles: ['admin', 'comptable', 'chef_prod'] },
  { key: 'clients', label: 'Clients', roles: ['admin', 'comptable'] },
  { key: 'abonnements', label: 'Abonnements', roles: ['admin', 'comptable'] },
  { key: 'commandes', label: 'Commandes', roles: ['admin', 'comptable'] },
  { key: 'logistique', label: 'Logistique', roles: ['admin', 'comptable', 'livreur'] },
  { key: 'finance', label: 'Finance', roles: ['admin', 'comptable'] },
  { key: 'comptabilite', label: 'Comptabilité', roles: ['admin', 'comptable'] },
  { key: 'tickets', label: 'Support client', roles: ['admin', 'comptable'] },
  { key: 'utilisateurs', label: 'Utilisateurs', roles: ['admin'] },
  { key: 'audit', label: "Journal d'audit", roles: ['admin'] },
];

let currentTab = null;

// PWA installable + cache de l'app shell pour un usage terrain hors-ligne (cahier des charges §4).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.error('Échec enregistrement service worker:', err));
  });
}

// Synchronisation de la file d'attente hors-ligne (preuves de livraison, encaissements saisis sans
// réseau) : à la reconnexion, périodiquement, et une fois au démarrage — pas besoin d'action de
// l'utilisateur. Le badge reste discret (masqué) tant qu'il n'y a rien en attente.
function rafraichirBadgeSync() {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  const n = OfflineQueue.taille();
  badge.classList.toggle('hidden', n === 0);
  badge.textContent = n > 0 ? `${n} en attente` : '';
}
OfflineQueue.surChangement(rafraichirBadgeSync);

async function tenterSyncHorsLigne() {
  const { reussies } = await OfflineQueue.synchroniser();
  if (reussies > 0) {
    showToast(`${reussies} action(s) hors-ligne envoyée(s) au serveur.`, 'success');
    if (currentTab === 'logistique') selectTab('logistique');
  }
}
window.addEventListener('online', tenterSyncHorsLigne);
setInterval(tenterSyncHorsLigne, 30000);

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
window.showToast = showToast;

function fmt(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}
window.fmt = fmt;

// Formatte une date SQL (DATE ou TIMESTAMP) en JJ/MM/AAAA sans glissement de fuseau horaire :
// on lit directement les composants "YYYY-MM-DD" plutôt que de passer par new Date(...).toLocaleDateString().
function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
window.fmtDate = fmtDate;

// Échappement HTML : toute donnée provenant d'une saisie utilisateur (nom, notes, libellé...) doit
// passer par ici avant d'être insérée dans un template littéral assigné à innerHTML, sans quoi un
// utilisateur peu privilégié peut stocker du HTML/JS qui s'exécutera dans la session d'un autre
// utilisateur (XSS stocké) — ex: un nom de client affiché tel quel dans le Journal d'audit admin.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
window.esc = esc;

/**
 * Génère un mini-graphique SVG en courbe (sans dépendance externe) pour visualiser une évolution
 * dans le temps — ex : courbe de croissance (poids moyen) en Avicole/Piscicole.
 * points : [{ date: 'YYYY-MM-DD', value: number }, ...] triés du plus ancien au plus récent.
 */
function lineChartSvg(points, { width = 560, height = 150, color = '#6FA834', unit = '' } = {}) {
  if (!points || points.length === 0) {
    return `<div class="empty">Pas assez de données pour tracer une courbe.</div>`;
  }
  const padL = 44;
  const padR = 14;
  const padT = 14;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const values = points.map((p) => Number(p.value) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const x = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - min) / (max - min)) * innerH;

  const linePoints = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const dots = points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="${color}" />`)
    .join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Courbe de croissance">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + innerH}" stroke="currentColor" stroke-opacity="0.15" />
      <line x1="${padL}" y1="${padT + innerH}" x2="${padL + innerW}" y2="${padT + innerH}" stroke="currentColor" stroke-opacity="0.15" />
      <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">${fmt(max)}${unit}</text>
      <text x="${padL - 8}" y="${padT + innerH}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">${fmt(min)}${unit}</text>
      <text x="${padL}" y="${height - 6}" font-size="10" fill="currentColor" opacity="0.6">${fmtDate(points[0].date)}</text>
      <text x="${padL + innerW}" y="${height - 6}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">${fmtDate(points[points.length - 1].date)}</text>
      <polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
    </svg>
  `;
}
window.lineChartSvg = lineChartSvg;

// Petite modale maison (remplace prompt()/confirm() natifs, peu fiables et intrusifs).
// Usage : Modal.open('Titre', [{ name, label, type, value }]) -> Promise<values|null>
// type: 'select' attend en plus { options: [{ value, label }, ...] }.
const Modal = {
  open(title, fields) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box">
          <h3>${title}</h3>
          <div class="modal-fields">
            ${fields
              .map((f, i) => {
                if (f.type === 'select') {
                  return `<label>${f.label}<select data-field="${i}">${(f.options || [])
                    .map((o) => `<option value="${o.value}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${o.label}</option>`)
                    .join('')}</select></label>`;
                }
                return `<label>${f.label}<input type="${f.type || 'text'}" data-field="${i}" value="${f.value ?? ''}" /></label>`;
              })
              .join('')}
          </div>
          <div class="modal-actions">
            <button class="secondary" data-action="cancel">Annuler</button>
            <button data-action="ok">Valider</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      overlay.querySelector('[data-action="ok"]').addEventListener('click', () => {
        const values = {};
        fields.forEach((f, i) => {
          values[f.name] = overlay.querySelector(`[data-field="${i}"]`).value;
        });
        close(values);
      });
    });
  },
};
window.Modal = Modal;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
window.el = el;

function tabsForRole(role) {
  return TAB_DEFS.filter((t) => t.roles.includes(role) || role === 'admin');
}

async function selectTab(key) {
  currentTab = key;
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.key === key);
  });
  const view = document.getElementById('view');
  view.innerHTML = '<div class="empty">Chargement…</div>';
  const module = Views[key];
  if (!module) {
    view.innerHTML = '<div class="empty">Module introuvable.</div>';
    return;
  }
  try {
    await module.render(view);
  } catch (err) {
    view.innerHTML = `<div class="panel"><p class="login-error">${err.message}</p></div>`;
  }
}

function buildShell(user) {
  document.getElementById('who-name').textContent = user.nom_complet || user.email;
  document.getElementById('who-role').textContent = roleLabel(user.role);

  const tabs = tabsForRole(user.role);
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    btn.dataset.key = t.key;
    btn.addEventListener('click', () => selectTab(t.key));
    nav.appendChild(btn);
  });

  selectTab(tabs[0]?.key || 'dashboard');
}

function roleLabel(role) {
  return {
    admin: 'Super-Administrateur',
    comptable: 'Comptable',
    chef_prod: 'Chef de production',
    livreur: 'Livreur',
  }[role] || role;
}

function showApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  buildShell(Api.getUser());
  rafraichirBadgeSync();
  tenterSyncHorsLigne();
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
    const data = await Api.post('/auth/login', {
      email: form.get('email'),
      password: form.get('password'),
    });
    Api.setSession(data.token, data.utilisateur);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  Api.clearSession();
  showLogin();
});

(function init() {
  if (Api.getToken() && Api.getUser()) {
    showApp();
  } else {
    showLogin();
  }
})();

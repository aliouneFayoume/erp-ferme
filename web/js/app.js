const Views = window.Views || {};

const TAB_DEFS = [
  { key: 'dashboard', label: 'Tableau de bord', roles: ['admin', 'comptable'] },
  { key: 'production', label: 'Production', roles: ['admin', 'chef_prod'] },
  { key: 'catalogue', label: 'Catalogue & Stock', roles: ['admin', 'comptable', 'chef_prod'] },
  { key: 'clients', label: 'Clients', roles: ['admin', 'comptable'] },
  { key: 'abonnements', label: 'Abonnements', roles: ['admin', 'comptable'] },
  { key: 'commandes', label: 'Commandes', roles: ['admin', 'comptable'] },
  { key: 'fournisseurs', label: 'Fournisseurs', roles: ['admin', 'comptable'] },
  { key: 'logistique', label: 'Logistique', roles: ['admin', 'comptable', 'livreur'] },
  { key: 'finance', label: 'Finance', roles: ['admin', 'comptable'] },
  { key: 'comptabilite', label: 'Comptabilité', roles: ['admin', 'comptable'] },
  { key: 'tickets', label: 'Support client', roles: ['admin', 'comptable'] },
  { key: 'parametres-paiement', label: 'Paiements (réglages)', roles: ['admin'] },
  { key: 'utilisateurs', label: 'Utilisateurs', roles: ['admin'] },
  { key: 'audit', label: "Journal d'audit", roles: ['admin'] },
];

// Icônes minimalistes (trait fin, 18x18) pour la sidebar — pas de dépendance à une librairie externe.
const TAB_ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  production: '<path d="M12 21c0-6 4-8 4-13a4 4 0 0 0-8 0c0 5 4 7 4 13Z"/><path d="M12 12v9"/>',
  catalogue: '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  clients: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  abonnements: '<path d="M21 12a9 9 0 0 1-15.3 6.4M3 12a9 9 0 0 1 15.3-6.4"/><path d="M21 5v5h-5M3 19v-5h5"/>',
  commandes: '<path d="M4 8h16l-1.5 11a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  fournisseurs: '<rect x="2" y="10" width="20" height="9" rx="1"/><path d="M6 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/><path d="M12 14v2"/>',
  logistique: '<rect x="1" y="7" width="13" height="10" rx="1"/><path d="M14 10h4l4 4v3h-8z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  finance: '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M6 6V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
  comptabilite: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 7h8M8 12h8M8 17h4"/>',
  tickets: '<path d="M4 4h16v12H8l-4 4V4Z"/>',
  'parametres-paiement': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 14h4"/>',
  utilisateurs: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="18" cy="9" r="2.6"/><path d="M15.5 14a5.5 5.5 0 0 1 6.5 5.4"/>',
  audit: '<path d="M9 3h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1V4a1 1 0 0 1 1-1Z"/><path d="M9 11h6M9 15h6"/>',
};

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
async function rafraichirBadgeSync(queue) {
  const indicator = document.getElementById('sync-indicator');
  const count = document.getElementById('sync-count');
  if (!indicator || !count) return;
  const n = (queue || (await OfflineQueue.lire())).length;
  indicator.classList.toggle('pending', n > 0);
  indicator.title = n > 0 ? `${n} action(s) en attente d'envoi au serveur` : 'Toutes les actions sont synchronisées';
  count.classList.toggle('hidden', n === 0);
  count.textContent = n > 9 ? '9+' : String(n);
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

// Prévient une seule fois par période hors-ligne (pas à chaque appel API) que les données
// affichées viennent du cache local plutôt que du serveur.
let offlineReadToastShown = false;
window.addEventListener('erp:offline-read', () => {
  if (offlineReadToastShown) return;
  offlineReadToastShown = true;
  showToast('Hors-ligne : affichage des dernières données connues (peut-être pas à jour).', 'info');
});
window.addEventListener('online', () => {
  offlineReadToastShown = false;
});

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
function lineChartSvg(points, { width = 560, height = 150, color = '#5B8C3A', unit = '' } = {}) {
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

// Champ numérique avec boutons +/- (saisie terrain au doigt : mortalité, aliment, récolte...).
// L'input reste éditable au clavier normalement ; les boutons ne font que le nudger.
function numberStepperHTML(label, name, { value = 0, min, step = 1 } = {}) {
  return `
    <label>${label}
      <div class="stepper">
        <button type="button" class="stepper-btn" data-action="dec" aria-label="Diminuer">−</button>
        <input type="number" name="${name}" value="${value}" ${min !== undefined ? `min="${min}"` : ''} step="${step}" inputmode="decimal" />
        <button type="button" class="stepper-btn" data-action="inc" aria-label="Augmenter">+</button>
      </div>
    </label>
  `;
}
window.numberStepperHTML = numberStepperHTML;

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.stepper-btn');
  if (!btn) return;
  const input = btn.closest('.stepper').querySelector('input');
  const step = Number(input.step) || 1;
  const min = input.min !== '' ? Number(input.min) : -Infinity;
  let val = (Number(input.value) || 0) + (btn.dataset.action === 'inc' ? step : -step);
  if (val < min) val = min;
  const decimals = (String(step).split('.')[1] || '').length;
  input.value = decimals ? val.toFixed(decimals) : String(val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

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
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.key === key);
  });
  closeSidebar();
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

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.remove('hidden');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.add('hidden');
}
document.getElementById('btn-menu-toggle').addEventListener('click', openSidebar);
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

// Repli de la sidebar en mode icônes seules (desktop uniquement) — mémorisé pour la session suivante.
const SIDEBAR_COLLAPSED_KEY = 'erp_sidebar_collapsed';
function applySidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('btn-sidebar-collapse');
  sidebar.classList.toggle('collapsed', collapsed);
  toggle.querySelector('span').textContent = collapsed ? 'Agrandir' : 'Réduire';
  toggle.title = collapsed ? 'Agrandir le menu' : 'Réduire le menu';
}
document.getElementById('btn-sidebar-collapse').addEventListener('click', () => {
  const collapsed = !document.getElementById('sidebar').classList.contains('collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  applySidebarCollapsed(collapsed);
});
applySidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');

function buildShell(user) {
  document.getElementById('who-name').textContent = user.nom_complet || user.email;
  document.getElementById('who-role').textContent = roleLabel(user.role);

  const tabs = tabsForRole(user.role);
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  tabs.forEach((t) => {
    const btn = document.createElement('button');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[t.key] || ''}</svg><span>${t.label}</span>`;
    btn.dataset.key = t.key;
    btn.title = t.label;
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

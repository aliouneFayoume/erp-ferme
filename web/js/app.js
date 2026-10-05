const Views = window.Views || {};

const TAB_DEFS = [
  { key: 'dashboard', label: 'Tableau de bord', roles: ['admin', 'comptable'] },
  { key: 'production', label: 'Production', roles: ['admin', 'chef_prod'] },
  { key: 'elevage', label: 'Élevage', roles: ['admin', 'chef_prod'] },
  { key: 'catalogue', label: 'Catalogue & Stock', roles: ['admin', 'comptable', 'chef_prod'] },
  { key: 'clients', label: 'Clients', roles: ['admin', 'comptable'] },
  { key: 'abonnements', label: 'Abonnements', roles: ['admin', 'comptable'] },
  { key: 'commandes', label: 'Commandes', roles: ['admin', 'comptable'] },
  { key: 'fournisseurs', label: 'Fournisseurs', roles: ['admin', 'comptable'] },
  { key: 'intrants', label: 'Intrants & Stock', roles: ['admin', 'chef_prod', 'comptable'] },
  { key: 'paie', label: 'Paie', roles: ['admin', 'comptable'] },
  { key: 'logistique', label: 'Logistique', roles: ['admin', 'comptable', 'livreur'] },
  { key: 'finance', label: 'Finance', roles: ['admin', 'comptable'] },
  { key: 'comptabilite', label: 'Comptabilité', roles: ['admin', 'comptable'] },
  { key: 'tickets', label: 'Support client', roles: ['admin', 'comptable'] },
  { key: 'parametres-paiement', label: 'Réglages de la ferme', roles: ['admin'] },
  { key: 'utilisateurs', label: 'Utilisateurs', roles: ['admin'] },
  { key: 'audit', label: "Journal d'audit", roles: ['admin'] },
  { key: 'mon-compte', label: 'Mon compte', roles: ['admin', 'comptable', 'chef_prod', 'livreur'] },
  { key: 'assistant', label: 'Assistant IA', roles: ['admin', 'comptable', 'chef_prod', 'livreur'] },
  // Réservé à un seul compte (voir migration-04-superviseur-plateforme.sql) — jamais visible pour
  // un admin normal, même si `roles` incluait 'admin' : voir tabsForRole ci-dessous.
  { key: 'plateforme', label: 'Support plateforme', roles: [], superviseurSeulement: true },
];

// Icônes minimalistes (trait fin, 18x18) pour la sidebar — pas de dépendance à une librairie externe.
const TAB_ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  production: '<path d="M12 21c0-6 4-8 4-13a4 4 0 0 0-8 0c0 5 4 7 4 13Z"/><path d="M12 12v9"/>',
  elevage: '<path d="M7 10a3 3 0 1 1 6 0v1a3 3 0 1 1-6 0v-1Z"/><path d="M5 8V6M9 8V5M13 8V6"/><path d="M6 14c0 3 1.5 5 4 5s4-2 4-5"/>',
  catalogue: '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  clients: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  abonnements: '<path d="M21 12a9 9 0 0 1-15.3 6.4M3 12a9 9 0 0 1 15.3-6.4"/><path d="M21 5v5h-5M3 19v-5h5"/>',
  commandes: '<path d="M4 8h16l-1.5 11a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  fournisseurs: '<rect x="2" y="10" width="20" height="9" rx="1"/><path d="M6 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/><path d="M12 14v2"/>',
  intrants: '<path d="M20 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v2"/><path d="M4 8h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z"/><path d="M9 12v3M15 12v3"/>',
  paie: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M8 13h5"/><circle cx="8" cy="17" r="1"/>',
  logistique: '<rect x="1" y="7" width="13" height="10" rx="1"/><path d="M14 10h4l4 4v3h-8z"/><circle cx="6" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  finance: '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M6 6V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
  comptabilite: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 7h8M8 12h8M8 17h4"/>',
  tickets: '<path d="M4 4h16v12H8l-4 4V4Z"/>',
  'parametres-paiement': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20"/><path d="M6 14h4"/>',
  utilisateurs: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="18" cy="9" r="2.6"/><path d="M15.5 14a5.5 5.5 0 0 1 6.5 5.4"/>',
  audit: '<path d="M9 3h6a1 1 0 0 1 1 1v1h1a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h1V4a1 1 0 0 1 1-1Z"/><path d="M9 11h6M9 15h6"/>',
  'mon-compte': '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>',
  assistant: '<path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M8 9h8M8 12h5"/>',
  plateforme: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
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
  const libelle = document.getElementById('sync-label');
  if (libelle) libelle.textContent = n > 0 ? `${n} en attente` : 'Synchronisé';
  indicator.title = n > 0 ? `${n} action(s) en attente d'envoi au serveur` : 'Toutes les actions sont synchronisées';
  count.classList.toggle('hidden', n === 0);
  count.textContent = n > 9 ? '9+' : String(n);
}
OfflineQueue.surChangement(rafraichirBadgeSync);

// Évite de répéter le même toast à chaque tentative de sync (toutes les 30s) tant que la situation
// n'a pas changé — sinon un livreur dont la session a expiré verrait le message en boucle.
let sessionExpireeToastShown = false;
let dernierNombreEchecs = 0;

async function tenterSyncHorsLigne() {
  const { reussies, sessionExpiree } = await OfflineQueue.synchroniser();
  if (reussies > 0) {
    showToast(`${reussies} action(s) hors ligne envoyée(s) au serveur.`, 'success');
    if (currentTab === 'logistique' || currentTab === 'production') selectTab(currentTab);
  }
  if (sessionExpiree) {
    if (!sessionExpireeToastShown) {
      sessionExpireeToastShown = true;
      showToast("Session expirée : reconnectez-vous pour envoyer les actions en attente (rien n'est perdu).", 'error');
    }
  } else {
    sessionExpireeToastShown = false;
  }
  // Alerte seulement quand le nombre d'échecs augmente (nouvel item mort), pas à chaque intervalle.
  const echecs = await OfflineQueue.lireEchecs();
  if (echecs.length > dernierNombreEchecs) {
    showToast(
      `${echecs.length} action(s) n'ont pas pu être envoyées après plusieurs tentatives. Contactez le support.`,
      'error'
    );
  }
  dernierNombreEchecs = echecs.length;
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
// Format court du kit : « 1er oct. 2026 ».
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtDate(dateStr) {
  if (!dateStr) return '-';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  const mois = MOIS_COURTS[Number(m) - 1];
  if (!mois) return `${d}/${m}/${y}`;
  return `${Number(d) === 1 ? '1er' : Number(d)} ${mois} ${y}`;
}
window.fmtDate = fmtDate;

// Téléphone au format du kit : « +221 77 123 45 67 » (numéros sénégalais ; tout autre numéro est laissé tel quel).
function fmtTel(tel) {
  const chiffres = String(tel || '').replace(/[^\d+]/g, '');
  const m = chiffres.match(/^(?:\+221|00221)?(7\d)(\d{3})(\d{2})(\d{2})$/);
  return m ? `+221 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(tel || '');
}
window.fmtTel = fmtTel;

// Libellé français d'un état technique (EN_RETARD → « En retard ») pour les badges et boutons.
const LIBELLES_STATUT = {
  EN_ATTENTE: 'En attente', PREPAREE: 'Préparée', EN_LIVRAISON: 'En livraison', LIVREE: 'Livrée', ANNULEE: 'Annulée',
  A_PAYER: 'À payer', PAYEE_PARTIEL: 'Payée en partie', PAYEE: 'Payée', EN_RETARD: 'En retard',
  VALIDE: 'Validé', ECHOUE: 'Échoué', COMMANDEE: 'Commandée', RECUE: 'Reçue',
  A_FAIRE: 'À faire', EN_COURS: 'En cours', TERMINEE: 'Terminée', ECHOUEE: 'Échouée',
};
window.libelleStatut = (code) =>
  LIBELLES_STATUT[code] || String(code).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

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

// Largeur du graphique = largeur disponible dans la zone principale (le SVG garde ainsi son échelle 1:1 et
// ses textes restent lisibles sur téléphone), bornée entre 260 et 560.
function largeurGraphique() {
  const zone = document.getElementById('view');
  return Math.min(560, Math.max(260, (zone ? zone.clientWidth : 600) - 80));
}

/**
 * Génère un mini-graphique SVG en courbe (sans dépendance externe) pour visualiser une évolution
 * dans le temps — ex : courbe de croissance (poids moyen) en Avicole/Piscicole.
 * points : [{ date: 'YYYY-MM-DD', value: number }, ...] triés du plus ancien au plus récent.
 */
function lineChartSvg(points, { width = largeurGraphique(), height = 160, color = 'var(--dakar-700)', unit = '' } = {}) {
  if (!points || points.length === 0) {
    return `<div class="empty">Pas assez de données pour tracer une courbe.</div>`;
  }
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const innerH = height - padT - padB;

  const values = points.map((p) => Number(p.value) || 0);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  // marge gauche = largeur de l'étiquette la plus longue de l'axe vertical (texte de 13 px, ~7,4 px par caractère)
  const padL = Math.max(48, Math.max(`${fmt(max)}${unit}`.length, `${fmt(min)}${unit}`.length) * 7.4 + 14);
  const innerW = width - padL - padR;

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
      <text x="${padL - 8}" y="${padT + 4}" text-anchor="end" font-size="13" fill="currentColor" opacity="0.75">${fmt(max)}${unit}</text>
      <text x="${padL - 8}" y="${padT + innerH}" text-anchor="end" font-size="13" fill="currentColor" opacity="0.75">${fmt(min)}${unit}</text>
      <text x="${padL}" y="${height - 6}" font-size="13" fill="currentColor" opacity="0.75">${fmtDate(points[0].date)}</text>
      <text x="${padL + innerW}" y="${height - 6}" text-anchor="end" font-size="13" fill="currentColor" opacity="0.75">${fmtDate(points[points.length - 1].date)}</text>
      <polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
    </svg>
  `;
}
window.lineChartSvg = lineChartSvg;

// Valeur résolue d'un jeton CSS (pour les API qui n'acceptent pas var(), ex. les options de Leaflet).
function jetonCss(nom) {
  return getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
}
window.jetonCss = jetonCss;

// Améliorations d'accessibilité appliquées à tout ce que les vues injectent dans la page (sans toucher
// à chaque vue) : clavier adapté aux champs numériques et téléphone (kit : tel / numeric / decimal),
// libellé de colonne sur chaque cellule de tableau (sert à l'affichage en cartes sur téléphone) et
// alignement à droite des en-têtes de colonnes numériques.
// Champs posés en ligne dans un tableau ou une carte, sans <label> visible : on leur donne un nom accessible
// (lecteur d'écran, saisie vocale) à partir de leur rôle et du contexte de la ligne.
const NOMS_CHAMPS = {
  'select-produit-oeufs': 'Produit alimenté par les œufs',
  'input-oeufs-par-plateau': 'Œufs par plateau',
  'ligne-produit': 'Produit', 'ligne-qte': 'Quantité', 'ligne-designation': 'Article', 'ligne-unite': 'Unité',
  'ligne-prix': 'Prix unitaire', 'ligne-intrant': 'Intrant lié au stock',
  'select-paiement': 'Paiement à rapprocher',
  'select-aliment-defaut': 'Aliment par défaut',
  'select-cloture': 'Motif de clôture du lot',
};
function nommerChampsSansLibelle(racine) {
  racine.querySelectorAll('input:not([type="hidden"]):not([type="file"]), select, textarea').forEach((champ) => {
    if (champ.closest('label') || champ.getAttribute('aria-label') || champ.getAttribute('aria-labelledby')) return;
    if (champ.id && document.querySelector(`label[for="${champ.id}"]`)) return;
    let nom = [...champ.classList].map((c) => NOMS_CHAMPS[c]).find(Boolean) || champ.getAttribute('placeholder') || champ.getAttribute('title');
    if (!nom) return;
    const contexte = champ.closest('.lot-card')?.querySelector('.code')?.textContent || champ.closest('tr')?.firstElementChild?.textContent;
    if (contexte && contexte.trim() && !champ.classList.contains('ligne-designation')) nom += ` — ${contexte.trim().slice(0, 40)}`;
    champ.setAttribute('aria-label', nom);
  });
}
function ameliorerChamps(racine) {
  nommerChampsSansLibelle(racine);
  racine.querySelectorAll('input:not([inputmode])').forEach((champ) => {
    const nom = `${champ.name || ''} ${champ.id || ''}`;
    if (champ.type === 'tel' || /(^|[\s_-])(tel|telephone|phone|whatsapp)/i.test(nom)) champ.setAttribute('inputmode', 'tel');
    else if (champ.type === 'number') {
      const decimal = champ.step === 'any' || (champ.step && Number(champ.step) % 1 !== 0) || /prix|montant|tarif|taux/i.test(nom);
      champ.setAttribute('inputmode', decimal ? 'decimal' : 'numeric');
    }
  });
}
function ameliorerTableaux(racine) {
  // idempotent : peut être rejoué quand des lignes sont ajoutées après coup à un tableau existant
  const tableaux = new Set(racine.querySelectorAll('table'));
  const parent = racine.closest('table');
  if (parent) tableaux.add(parent);
  tableaux.forEach((tableau) => {
    const entetes = [...tableau.querySelectorAll('thead th')];
    if (!entetes.length) return;
    const lignes = [...tableau.querySelectorAll('tbody tr')].map((tr) => [...tr.children]).filter((c) => c.length === entetes.length && !c.some((td) => td.colSpan > 1));
    lignes.forEach((cellules) => cellules.forEach((td, i) => td.setAttribute('data-label', entetes[i].textContent.trim())));
    if (lignes.length) tableau.classList.add('en-cartes'); // affichage en liste de cartes sur téléphone (voir style.css)
    entetes.forEach((th, i) => {
      if (lignes.length && lignes.every((cellules) => cellules[i].classList.contains('num'))) th.classList.add('num');
    });
  });
}
function ameliorerPage(racine) {
  if (racine.nodeType !== 1) return;
  ameliorerChamps(racine);
  ameliorerTableaux(racine);
}
new MutationObserver((mutations) => mutations.forEach((m) => m.addedNodes.forEach(ameliorerPage))).observe(document.body, { childList: true, subtree: true });
ameliorerPage(document.body);

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
                const autocomplete = f.type === 'password' ? 'new-password' : 'off';
                return `<label>${f.label}<input type="${f.type || 'text'}" data-field="${i}" value="${f.value ?? ''}" autocomplete="${autocomplete}" /></label>`;
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

// Sélecteur de point GPS en grand plan (remplace une petite carte toujours visible et minuscule) :
// on l'ouvre seulement au moment de choisir, la carte occupe presque tout l'écran pour cliquer
// précisément, puis on la referme explicitement une fois le point validé (ou annulé).
// Usage : MapPicker.open({ lat, lng, markers: [{ lat, lng, label }] }) -> Promise<{lat,lng}|null>
// Leaflet (carte) n'est chargé qu'au moment où une carte s'ouvre : il n'alourdit plus le premier écran
// (≈ 56 Ko compressés + une connexion vers un autre domaine, sur chaque page, même sans carte).
let promesseLeaflet = null;
function chargerLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!promesseLeaflet) {
    promesseLeaflet = new Promise((resolve) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = () => resolve(window.L || null);
      js.onerror = () => { promesseLeaflet = null; resolve(null); }; // hors ligne : on pourra réessayer plus tard
      document.head.appendChild(js);
    });
  }
  return promesseLeaflet;
}
window.chargerLeaflet = chargerLeaflet;

const MapPicker = {
  open({ lat, lng, markers = [] } = {}) {
    return chargerLeaflet().then((L) => new Promise((resolve) => {
      if (!L) { showToast('Carte indisponible : vérifiez votre connexion.', 'error'); resolve(null); return; }
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-box modal-box-map">
          <h3>Choisir le point GPS</h3>
          <p class="desc">Cliquez sur la carte à l'emplacement exact — vous pourrez zoomer pour affiner.</p>
          <div class="map-picker-canvas"></div>
          <div class="modal-actions">
            <button class="secondary" data-action="cancel">Fermer</button>
            <button data-action="ok" ${lat && lng ? '' : 'disabled'}>Valider ce point</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const map = L.map(overlay.querySelector('.map-picker-canvas')).setView(
        [lat || 14.7167, lng || -17.4677],
        lat && lng ? 16 : 11
      );
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles © Esri — Source: Esri, DeLorme, NAVTEQ',
        maxZoom: 19,
      }).addTo(map);
      markers.forEach((m) => L.marker([m.lat, m.lng]).addTo(map).bindPopup(m.label || ''));

      const btnOk = overlay.querySelector('[data-action="ok"]');
      let picked = lat && lng ? { lat, lng } : null;
      let marker = picked ? L.marker([picked.lat, picked.lng]).addTo(map) : null;
      map.on('click', (e) => {
        picked = e.latlng;
        if (marker) marker.remove();
        marker = L.marker([picked.lat, picked.lng]).addTo(map);
        btnOk.disabled = false;
      });
      // La carte est créée juste après son insertion dans le DOM : un recalcul de taille garantit
      // qu'elle occupe bien tout le conteneur même si le tout premier rendu l'a mesurée à 0.
      setTimeout(() => map.invalidateSize(), 50);

      const close = (result) => {
        map.remove();
        overlay.remove();
        resolve(result);
      };
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      btnOk.addEventListener('click', () => close(picked));
    }));
  },
};
window.MapPicker = MapPicker;

// Champ numérique avec boutons +/- (saisie terrain au doigt : mortalité, aliment, récolte...).
// L'input reste éditable au clavier normalement ; les boutons ne font que le nudger.
// `step` = incrément des boutons + / − UNIQUEMENT (data-step). Le champ lui-même est en step="any" : avec un
// pas HTML de 0,5 (aliment) ou de 10 (poids), le navigateur refusait 2,3 kg ou 125 g à l'envoi du formulaire
// (constaté en démo, 2026-09-24) alors que la base accepte les décimales.
// `entier: true` pour un NOMBRE D'ÉLÉMENTS (poissons morts, œufs) : colonne INT en base, donc le champ garde un pas de
// validation de 1 — sans quoi 2,5 poissons morts ferait échouer l'enregistrement de tout le relevé. `hint` = petite
// phrase d'aide sous le champ.
function numberStepperHTML(label, name, { value = 0, min, step = 1, entier = false, hint = '' } = {}) {
  return `
    <label>${label}
      <div class="stepper">
        <button type="button" class="stepper-btn" data-action="dec" aria-label="Diminuer">−</button>
        <input type="number" name="${name}" value="${value}" ${min !== undefined ? `min="${min}"` : ''} step="${entier ? 1 : 'any'}" data-step="${step}" inputmode="${entier ? 'numeric' : 'decimal'}" />
        <button type="button" class="stepper-btn" data-action="inc" aria-label="Augmenter">+</button>
      </div>
      ${hint ? `<small style="display:block;color:var(--ink-muted);font-size:13px;margin-top:2px;font-weight:400">${hint}</small>` : ''}
    </label>
  `;
}
window.numberStepperHTML = numberStepperHTML;

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.stepper-btn');
  if (!btn) return;
  const input = btn.closest('.stepper').querySelector('input');
  const step = Number(input.dataset.step) || 1;
  const min = input.min !== '' ? Number(input.min) : -Infinity;
  const courant = Number(input.value) || 0;
  let val = courant + (btn.dataset.action === 'inc' ? step : -step);
  if (val < min) val = min;
  // Garde les décimales déjà saisies (2,35 + 0,5 = 2,85, pas 2,9) : on arrondit seulement le bruit flottant.
  const decimalesDe = (n) => (String(n).split('.')[1] || '').length;
  const decimals = Math.min(3, Math.max(decimalesDe(step), decimalesDe(courant)));
  input.value = decimals ? String(Number(val.toFixed(decimals))) : String(val);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
window.el = el;

function tabsForRole(user) {
  return TAB_DEFS.filter((t) => {
    // Ne suit jamais le raccourci "admin voit tout" — n'est vrai que pour ce seul compte, quel que
    // soit son rôle (voir migration-04-superviseur-plateforme.sql).
    if (t.superviseurSeulement) return !!user.superviseurPlateforme;
    // Modules SaaS : `onglets` (GET /auth/me) = Socle + modules souscrits ; absent/null = aucune
    // restriction. Purement visuel — le serveur refuse de toute façon un module non souscrit.
    if (Array.isArray(user.onglets) && !user.onglets.includes(t.key)) return false;
    return t.roles.includes(user.role) || user.role === 'admin';
  });
}

// Un module (ex. 'finance') est-il inclus dans l'abonnement de la ferme ? `modules` null/absent =
// aucune restriction (pas d'abonnement, Pack tout compris, ferme plateforme). Sert aux écrans qui
// mélangent Socle et module (Réglages de la ferme).
window.aModule = function aModule(cle) {
  const user = Api.getUser();
  return !user || !Array.isArray(user.modules) || user.modules.includes(cle);
};

// Relit les onglets/modules autorisés à chaque chargement, pour qu'un changement d'abonnement fait
// par le superviseur s'applique sans reconnexion. Toute erreur (hors-ligne sans cache, session
// expirée) laisse l'état connu en place : l'API reste la vraie barrière.
async function rafraichirAcces() {
  try {
    const data = await Api.get('/auth/me');
    const user = Api.getUser();
    if (!user || !data || !data.utilisateur) return;
    Api.setSession(Api.getToken(), { ...user, onglets: data.utilisateur.onglets ?? null, modules: data.utilisateur.modules ?? null });
  } catch (err) {
    /* état connu conservé */
  }
}

// En-tête de page (titre + sous-titre) : hors de la zone #view pour survivre aux rafraîchissements
// partiels des vues. Le tableau de bord accueille la personne par son prénom, avec la date du jour.
function majEnTetePage(key) {
  const titre = document.getElementById('page-title');
  const sous = document.getElementById('page-sub');
  if (!titre || !sous) return;
  const user = Api.getUser() || {};
  if (key === 'dashboard') {
    const prenom = String(user.nom_complet || '').trim().split(/\s+/)[0];
    const jour = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    titre.textContent = prenom ? `Bon retour, ${prenom}` : 'Bon retour';
    sous.textContent = `${jour.charAt(0).toUpperCase()}${jour.slice(1)} · voici où en est la ferme aujourd'hui`;
    sous.classList.remove('hidden');
  } else {
    const def = TAB_DEFS.find((t) => t.key === key);
    titre.textContent = def ? def.label : '';
    sous.classList.add('hidden');
  }
}

async function selectTab(key) {
  currentTab = key;
  majEnTetePage(key);
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.key === key);
  });
  majBarreOnglets();
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

// Barre d'onglets du téléphone : 3 raccourcis choisis parmi les onglets autorisés (dans cet ordre de
// priorité) + « Menu » qui ouvre la liste complète. Le kit en prévoit 4, icône 24 px + libellé toujours visible.
const LIBELLES_COURTS = { dashboard: 'Accueil', catalogue: 'Stock', 'mon-compte': 'Profil' };
const ONGLETS_PRIORITAIRES = ['dashboard', 'production', 'commandes', 'logistique', 'finance', 'catalogue', 'intrants', 'mon-compte'];
function construireBarreOnglets(tabs, mfaSetupRequis) {
  const barre = document.getElementById('tabbar');
  barre.innerHTML = '';
  const cles = tabs.map((t) => t.key);
  const choisis = ONGLETS_PRIORITAIRES.filter((k) => cles.includes(k));
  cles.forEach((k) => { if (!choisis.includes(k)) choisis.push(k); });
  const icone = (corps) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corps}</svg>`;
  choisis.slice(0, 3).forEach((k) => {
    const t = tabs.find((x) => x.key === k);
    const btn = document.createElement('button');
    btn.dataset.key = k;
    btn.innerHTML = `${icone(TAB_ICONS[k] || '')}<span>${LIBELLES_COURTS[k] || t.label.split(' ')[0]}</span>`;
    btn.setAttribute('aria-label', t.label);
    if (mfaSetupRequis && k !== 'mon-compte') btn.disabled = true;
    else btn.addEventListener('click', () => selectTab(k));
    barre.appendChild(btn);
  });
  const menu = document.createElement('button');
  menu.dataset.menu = '1';
  menu.innerHTML = `${icone('<path d="M3 6h18M3 12h18M3 18h18"/>')}<span>Menu</span>`;
  menu.setAttribute('aria-label', 'Ouvrir le menu complet');
  menu.addEventListener('click', openSidebar);
  barre.appendChild(menu);
  majBarreOnglets();
}
function majBarreOnglets() {
  const boutons = [...document.querySelectorAll('#tabbar button[data-key]')];
  const dansLaBarre = boutons.some((b) => b.dataset.key === currentTab);
  boutons.forEach((b) => (b.dataset.key === currentTab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  const menu = document.querySelector('#tabbar button[data-menu]');
  if (menu) (dansLaBarre ? menu.removeAttribute('aria-current') : menu.setAttribute('aria-current', 'page'));
}

function buildShell(user) {
  document.getElementById('topbar-brand').textContent = user.organisation_nom || 'Massla';
  document.title = user.organisation_nom ? `${user.organisation_nom} · Massla` : 'Massla';
  document.getElementById('who-name').textContent = user.nom_complet || user.email;
  document.getElementById('who-role').textContent = roleLabel(user.role);

  // Visible uniquement pendant une impersonation ("Se connecter en tant qu'administrateur" depuis
  // la vue plateforme) — permet de revenir à la session superviseur sans se reconnecter.
  const btnRetour = document.getElementById('btn-retour-supervision');
  const superviseurSession = Api.getSuperviseurSession();
  btnRetour.classList.toggle('hidden', !superviseurSession);

  const tabs = tabsForRole(user);
  const nav = document.getElementById('tabs');
  nav.innerHTML = '';
  // Durcissement sécurité (migration-20) : un admin dont le compte exige le MFA mais ne l'a pas
  // encore configuré (mfaSetupRequis, voir POST /auth/login) est confiné à "Mon compte" côté
  // écran — une aide visuelle seulement, la vraie barrière est côté serveur (requireAuth, auth.js).
  const mfaSetupRequis = !!user.mfaSetupRequis;
  tabs.forEach((t) => {
    const btn = document.createElement('button');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${TAB_ICONS[t.key] || ''}</svg><span>${t.label}</span>`;
    btn.dataset.key = t.key;
    btn.title = t.label;
    if (mfaSetupRequis && t.key !== 'mon-compte') {
      btn.disabled = true;
      btn.title = 'Configurez le MFA obligatoire avant de continuer.';
    } else {
      btn.addEventListener('click', () => selectTab(t.key));
    }
    nav.appendChild(btn);
  });
  construireBarreOnglets(tabs, mfaSetupRequis);

  selectTab(mfaSetupRequis ? 'mon-compte' : tabs[0]?.key || 'dashboard');
}

function roleLabel(role) {
  return {
    admin: 'Super-Administrateur',
    comptable: 'Comptable',
    chef_prod: 'Chef de production',
    livreur: 'Livreur',
  }[role] || role;
}

async function showApp() {
  await rafraichirAcces();
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

// Défi MFA (deuxième étape du login, voir routes/auth.js POST /mfa/verifier) : le challengeToken
// n'est jamais persisté (localStorage) — il ne vit que le temps de cet échange en mémoire.
let mfaChallengeToken = null;

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('login-error');
  const lienRenvoi = document.getElementById('login-renvoyer-verification');
  errEl.classList.add('hidden');
  lienRenvoi.classList.add('hidden');
  const champs = e.target.querySelectorAll('input[name="email"], input[name="password"]');
  champs.forEach((c) => c.removeAttribute('aria-invalid'));
  const bouton = e.target.querySelector('button[type="submit"]');
  const libelleBouton = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = 'Connexion…';
  try {
    const data = await Api.post('/auth/login', {
      email: form.get('email'),
      password: form.get('password'),
    });
    if (data.mfaRequis) {
      mfaChallengeToken = data.challengeToken;
      document.getElementById('mfa-challenge-texte').textContent =
        data.mfaMethode === 'WHATSAPP' ? 'Entrez le code reçu par WhatsApp.' : "Entrez le code de votre application d'authentification.";
      document.getElementById('login-form').classList.add('hidden');
      document.getElementById('mfa-challenge-form').classList.remove('hidden');
      return;
    }
    Api.setSession(data.token, data.utilisateur);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    champs.forEach((c) => c.setAttribute('aria-invalid', 'true'));
    if (err.code === 'EMAIL_NON_VERIFIE') {
      lienRenvoi.classList.remove('hidden');
    }
  } finally {
    bouton.disabled = false;
    bouton.textContent = libelleBouton;
  }
});

document.getElementById('lien-renvoyer-verification').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = document.querySelector('#login-form input[name="email"]').value;
  const errEl = document.getElementById('login-error');
  try {
    const data = await Api.post('/auth/renvoyer-verification', { email });
    errEl.classList.remove('hidden');
    errEl.textContent = data.message;
  } catch (err) {
    // Non atteignable en pratique (la route répond toujours 200) — filet de sécurité seulement.
    errEl.classList.remove('hidden');
    errEl.textContent = err.message;
  }
});

document.getElementById('mfa-challenge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const errEl = document.getElementById('mfa-challenge-error');
  errEl.classList.add('hidden');
  try {
    const data = await Api.post('/auth/mfa/verifier', { challengeToken: mfaChallengeToken, code: form.get('code') });
    mfaChallengeToken = null;
    Api.setSession(data.token, data.utilisateur);
    showApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

document.getElementById('btn-mfa-challenge-annuler').addEventListener('click', () => {
  mfaChallengeToken = null;
  document.getElementById('mfa-challenge-form').reset();
  document.getElementById('mfa-challenge-form').classList.add('hidden');
  document.getElementById('login-form').classList.remove('hidden');
});

document.getElementById('btn-logout').addEventListener('click', () => {
  Api.clearSession();
  showLogin();
});

document.getElementById('btn-retour-supervision').addEventListener('click', async () => {
  const superviseurSession = Api.getSuperviseurSession();
  if (!superviseurSession) return;
  // Journalise la fin de session AVANT de restaurer le jeton superviseur : passé ce point, le
  // jeton d'impersonation n'est plus celui utilisé par Api, cette requête doit donc partir avant
  // le changement — audit sécurité 2026-08-11 (E4). Best-effort : un échec réseau ne doit jamais
  // bloquer un superviseur qui essaie de sortir d'une session d'impersonation.
  try {
    await Api.post('/plateforme/fin-session-support', {});
  } catch (err) {
    console.error('Échec de la journalisation de fin de session support :', err);
  }
  Api.clearSuperviseurSession();
  Api.setSession(superviseurSession.token, superviseurSession.utilisateur);
  window.location.href = '/';
});

(function init() {
  if (Api.getToken() && Api.getUser()) {
    showApp();
  } else {
    showLogin();
  }
})();

window.Views = window.Views || {};

const OFFLINE_QUEUE_KEY = 'erp_offline_releves';
const OFFLINE_MODE_KEY = 'erp_offline_mode';

function getQueue() {
  return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
}
function setQueue(q) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(q));
}
function isOfflineMode() {
  return localStorage.getItem(OFFLINE_MODE_KEY) === '1';
}

const SECTEUR_ACCENT = { Avicole: 'var(--avicole)', Piscicole: 'var(--piscicole)', 'Maraîcher': 'var(--maraicher)' };
const SECTEUR_UNITE = { Avicole: 'sujets', Piscicole: 'alevins/poissons', 'Maraîcher': 'plants' };

function quantiteLabel(secteurNom) {
  return `Quantité initiale (nombre de ${SECTEUR_UNITE[secteurNom] || 'unités'})`;
}

// Planification des cultures (Maraîcher) : date de récolte prévue = démarrage + durée de maturité.
function dateRecoltePrevue(dateDemarrage, dureeMaturiteJours) {
  if (!dateDemarrage || !dureeMaturiteJours) return null;
  const d = new Date(dateDemarrage);
  d.setUTCDate(d.getUTCDate() + Number(dureeMaturiteJours));
  return d.toISOString().slice(0, 10);
}

function joursRestants(dateIso) {
  if (!dateIso) return null;
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const diffMs = new Date(dateIso).getTime() - new Date(aujourdhui).getTime();
  return Math.round(diffMs / 86400000);
}

window.Views.production = {
  async render(container) {
    const user = Api.getUser();
    const [secteurs, lots] = await Promise.all([Api.get('/production/secteurs'), Api.get('/production/lots')]);

    const secteursAutorises = secteurs.filter((s) => user.role === 'admin' || !user.secteur_id || s.id === user.secteur_id);

    container.innerHTML = `
      ${offlineBanner()}
      <div class="panel">
        <div class="panel-row">
          <div>
            <h2>Nouveau lot de production</h2>
            <p class="desc" style="margin-bottom:0">Créer un lot / bande / cycle d'élevage</p>
          </div>
        </div>
        <form id="form-lot" class="form-grid">
          <label>Secteur
            <select name="secteur_id" id="select-secteur-lot" required>
              ${secteursAutorises.map((s) => `<option value="${s.id}" data-nom="${s.nom}">${s.nom}</option>`).join('')}
            </select>
          </label>
          <label>Code du lot
            <input type="text" name="code_lot" placeholder="ex: AVI-2026-07" required />
          </label>
          <label><span id="label-quantite">${quantiteLabel(secteursAutorises[0]?.nom)}</span>
            <input type="number" name="quantite_initiale" min="1" step="1" required />
          </label>
          <label>Date de démarrage
            <input type="date" name="date_demarrage" required />
          </label>
          <label id="champ-culture" class="${secteursAutorises[0]?.nom === 'Maraîcher' ? '' : 'hidden'}">Culture (ex: Tomate)
            <input type="text" name="culture" placeholder="ex: Tomate" />
          </label>
          <label id="champ-duree" class="${secteursAutorises[0]?.nom === 'Maraîcher' ? '' : 'hidden'}">Durée avant récolte (jours)
            <input type="number" name="duree_maturite_jours" min="1" placeholder="ex: 90" />
          </label>
          <button type="submit">Créer le lot</button>
        </form>
      </div>

      <div class="panel">
        <h2>Lots en cours</h2>
        <p class="desc">Cliquez sur un lot pour saisir un relevé journalier (mortalité, alimentation, biométrie…)</p>
        <div class="card-list" id="lots-list"></div>
      </div>

      <div class="panel">
        <h2>Lots clôturés</h2>
        <p class="desc">Historique des lots terminés, envoyés à l'abattage ou déclarés perdus.</p>
        <div class="card-list" id="lots-clotures-list"></div>
      </div>

      <div class="panel hidden" id="releve-panel"></div>
    `;

    renderLotsList(container, lots);

    container.querySelector('#select-secteur-lot').addEventListener('change', (e) => {
      const nom = e.target.selectedOptions[0]?.dataset.nom;
      container.querySelector('#label-quantite').textContent = quantiteLabel(nom);
      container.querySelector('#champ-culture').classList.toggle('hidden', nom !== 'Maraîcher');
      container.querySelector('#champ-duree').classList.toggle('hidden', nom !== 'Maraîcher');
    });

    container.querySelector('#form-lot').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/production/lots', {
          secteur_id: Number(fd.get('secteur_id')),
          code_lot: fd.get('code_lot'),
          quantite_initiale: Number(fd.get('quantite_initiale')),
          date_demarrage: fd.get('date_demarrage'),
          culture: fd.get('culture') || null,
          duree_maturite_jours: fd.get('duree_maturite_jours') ? Number(fd.get('duree_maturite_jours')) : null,
        });
        showToast('Lot créé avec succès.', 'success');
        window.Views.production.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    updateOfflineBanner(container);
  },
};

const LOT_STATUT_BADGE = { EN_COURS: 'ok', ABATTAGE: 'info', TERMINE: 'muted', PERDU: 'danger' };
const LOT_STATUT_LABEL = { EN_COURS: 'En cours', ABATTAGE: 'Abattage', TERMINE: 'Terminé', PERDU: 'Perdu' };

function lotDataAttr(l) {
  return JSON.stringify({ id: l.id, code_lot: l.code_lot, secteur_nom: l.secteur_nom, statut: l.statut }).replace(/'/g, '&#39;');
}

function renderLotsList(container, lots) {
  const list = container.querySelector('#lots-list');
  const listClotures = container.querySelector('#lots-clotures-list');
  const actifs = lots.filter((l) => l.statut === 'EN_COURS');
  const clotures = lots.filter((l) => l.statut !== 'EN_COURS');

  if (actifs.length === 0) {
    list.innerHTML = '<div class="empty">Aucun lot en cours.</div>';
  } else {
    list.innerHTML = actifs
      .map((l) => {
        const recolte = l.secteur_nom === 'Maraîcher' ? dateRecoltePrevue(l.date_demarrage, l.duree_maturite_jours) : null;
        const restants = joursRestants(recolte);
        let badgeRecolte = '';
        if (recolte) {
          const classe = restants < 0 ? 'danger' : restants <= 7 ? 'warn' : 'muted';
          const texte = restants < 0 ? `en retard de ${Math.abs(restants)}j` : restants === 0 ? "aujourd'hui" : `dans ${restants}j`;
          badgeRecolte = `<div class="kpi"><span>Récolte prévue</span><b><span class="badge ${classe}">${fmtDate(recolte)} · ${texte}</span></b></div>`;
        }
        const optionFin = l.secteur_nom === 'Avicole' ? `<option value="ABATTAGE">Envoyé à l'abattage</option>` : `<option value="TERMINE">Terminé (récolté/vendu)</option>`;
        return `
        <div class="lot-card">
          <span class="tag-secteur" style="background:${SECTEUR_ACCENT[l.secteur_nom] || '#888'}">${esc(l.secteur_nom)}</span>
          <div class="code" style="margin-top:8px">${esc(l.code_lot)}${l.culture ? ` — ${esc(l.culture)}` : ''}</div>
          <div class="meta">Démarré le ${fmtDate(l.date_demarrage)} · ${esc(l.statut)}</div>
          <div class="kpi"><span>${l.secteur_nom === 'Maraîcher' ? 'Nombre de plants' : 'Effectif actuel'}</span><b>${fmt(l.quantite_initiale)}</b></div>
          ${badgeRecolte}
          <button class="secondary" style="margin-top:10px;width:100%" data-lot='${lotDataAttr(l)}'>
            Saisir un relevé / voir le FCR
          </button>
          <div style="margin-top:8px;display:flex;gap:6px">
            <select class="select-cloture" data-lot-id="${l.id}" style="flex:1">
              ${optionFin}
              <option value="PERDU">Perdu (échec/mortalité totale)</option>
            </select>
            <button class="secondary btn-cloturer" data-lot-id="${l.id}">Clôturer</button>
          </div>
        </div>
      `;
      })
      .join('');
  }

  listClotures.innerHTML = clotures.length
    ? clotures
        .map(
          (l) => `
        <div class="lot-card">
          <span class="tag-secteur" style="background:${SECTEUR_ACCENT[l.secteur_nom] || '#888'}">${esc(l.secteur_nom)}</span>
          <span class="badge ${LOT_STATUT_BADGE[l.statut] || 'muted'}" style="float:right">${LOT_STATUT_LABEL[l.statut] || esc(l.statut)}</span>
          <div class="code" style="margin-top:8px">${esc(l.code_lot)}${l.culture ? ` — ${esc(l.culture)}` : ''}</div>
          <div class="meta">Démarré le ${fmtDate(l.date_demarrage)}</div>
          <div class="kpi"><span>${l.secteur_nom === 'Maraîcher' ? 'Nombre de plants' : 'Effectif final'}</span><b>${fmt(l.quantite_initiale)}</b></div>
          <button class="secondary" style="margin-top:10px;width:100%" data-lot='${lotDataAttr(l)}'>
            Voir l'historique
          </button>
        </div>
      `
        )
        .join('')
    : '<div class="empty">Aucun lot clôturé.</div>';

  container.querySelectorAll('button[data-lot]').forEach((btn) => {
    btn.addEventListener('click', () => openRelevePanel(container, JSON.parse(btn.dataset.lot)));
  });

  container.querySelectorAll('button.btn-cloturer').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const select = container.querySelector(`.select-cloture[data-lot-id="${btn.dataset.lotId}"]`);
      const confirmation = await Modal.open('Clôturer ce lot ?', [
        { name: 'confirmer', label: `Tapez "OUI" pour confirmer (statut : ${select.selectedOptions[0].textContent})`, type: 'text', value: '' },
      ]);
      if (!confirmation || confirmation.confirmer.trim().toUpperCase() !== 'OUI') return;
      try {
        await Api.put(`/production/lots/${btn.dataset.lotId}/statut`, { statut: select.value });
        showToast('Lot clôturé.', 'success');
        window.Views.production.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

async function openRelevePanel(container, lot) {
  const panel = container.querySelector('#releve-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty">Chargement…</div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const [releves, fcr] = await Promise.all([
    Api.get(`/production/releves?lot_id=${lot.id}`),
    lot.secteur_nom !== 'Maraîcher' ? Api.get(`/production/lots/${lot.id}/fcr`) : Promise.resolve(null),
  ]);

  const courbePoints = releves
    .filter((r) => Number(r.poids_moyen_g) > 0)
    .map((r) => ({ date: r.date_releve, value: Number(r.poids_moyen_g) }))
    .reverse(); // l'API renvoie les relevés du plus récent au plus ancien ; la courbe se lit chronologiquement

  const courbeTaille = releves
    .filter((r) => Number(r.taille_moyenne_cm) > 0)
    .map((r) => ({ date: r.date_releve, value: Number(r.taille_moyenne_cm) }))
    .reverse();

  const champsSecteur =
    lot.secteur_nom === 'Piscicole'
      ? `
        <label>Taille moyenne (cm)<input type="number" step="0.1" name="taille_moyenne_cm" /></label>
        <label>Température eau (°C)<input type="number" step="0.1" name="temperature_eau" /></label>
        <label>pH eau<input type="number" step="0.1" name="ph_eau" /></label>
      `
      : lot.secteur_nom === 'Maraîcher'
      ? `
        <label>Intrants utilisés<input type="text" name="intrants_utilises" placeholder="ex: NPK 20kg" /></label>
        <label>Récolte du jour (kg)<input type="number" step="0.1" name="quantite_recoltee_kg" /></label>
      `
      : '';

  panel.innerHTML = `
    <div class="panel-row">
      <h2>${esc(lot.code_lot)} — ${esc(lot.secteur_nom)}</h2>
      <button class="secondary" id="close-releve">Fermer</button>
    </div>

    ${
      fcr
        ? `<div class="pill-row">
            <span class="pill">FCR (indice de consommation) : <b>${fcr.fcr ?? 'N/A'}</b></span>
            <span class="pill">Aliment cumulé : ${fmt(fcr.total_aliment_kg)} kg</span>
            <span class="pill">Poids moyen : ${fmt(fcr.poids_moyen_g)} g</span>
          </div>`
        : ''
    }

    ${
      lot.secteur_nom !== 'Maraîcher' && courbePoints.length >= 2
        ? `<div style="margin-top:14px">
            <div class="desc" style="margin-bottom:4px">Courbe de croissance (poids moyen, g)</div>
            ${lineChartSvg(courbePoints, { color: SECTEUR_ACCENT[lot.secteur_nom] || '#5B8C3A', unit: 'g' })}
          </div>`
        : ''
    }

    ${
      lot.secteur_nom === 'Piscicole' && courbeTaille.length >= 2
        ? `<div style="margin-top:14px">
            <div class="desc" style="margin-bottom:4px">Courbe de croissance (taille moyenne, cm)</div>
            ${lineChartSvg(courbeTaille, { color: '#3B7D7D', unit: 'cm' })}
          </div>`
        : ''
    }

    ${
      lot.statut && lot.statut !== 'EN_COURS'
        ? `<p class="desc" style="margin-top:16px">Ce lot est clôturé (${esc(LOT_STATUT_LABEL[lot.statut] || lot.statut)}) : aucun nouveau relevé ne peut être ajouté.</p>`
        : `<form id="form-releve" class="form-grid" style="margin-top:16px">
      <label>Date<input type="date" name="date_releve" required value="${new Date().toISOString().slice(0, 10)}" /></label>
      <label>Mortalité<input type="number" name="mortalite" min="0" value="0" /></label>
      <label>Conso. aliment (kg)<input type="number" step="0.1" name="conso_aliment_kg" value="0" /></label>
      <label>Poids moyen (g)<input type="number" step="0.1" name="poids_moyen_g" value="0" /></label>
      ${champsSecteur}
      <label>Notes<input type="text" name="notes" /></label>
      <button type="submit">Enregistrer le relevé</button>
    </form>`
    }

    <table style="margin-top:18px">
      <thead><tr><th>Date</th><th>Mortalité</th><th>Aliment (kg)</th><th>Poids (g)</th><th>Taille (cm)</th><th>Autres</th></tr></thead>
      <tbody>
        ${
          releves.length
            ? releves
                .map(
                  (r) => `<tr>
                    <td>${fmtDate(r.date_releve)}</td>
                    <td class="num">${fmt(r.mortalite)}</td>
                    <td class="num">${fmt(r.conso_aliment_kg)}</td>
                    <td class="num">${fmt(r.poids_moyen_g)}</td>
                    <td class="num">${r.taille_moyenne_cm ? fmt(r.taille_moyenne_cm) : '-'}</td>
                    <td>${[r.temperature_eau ? `${r.temperature_eau}°C` : '', r.ph_eau ? `pH ${r.ph_eau}` : '', r.quantite_recoltee_kg ? `${r.quantite_recoltee_kg}kg récoltés` : ''].filter(Boolean).join(' · ')}</td>
                  </tr>`
                )
                .join('')
            : '<tr><td colspan="6" class="empty">Aucun relevé.</td></tr>'
        }
      </tbody>
    </table>
  `;

  panel.querySelector('#close-releve').addEventListener('click', () => panel.classList.add('hidden'));

  const formReleve = panel.querySelector('#form-releve');
  if (!formReleve) return;

  formReleve.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const releve = {
      lot_id: lot.id,
      date_releve: fd.get('date_releve'),
      mortalite: Number(fd.get('mortalite') || 0),
      conso_aliment_kg: Number(fd.get('conso_aliment_kg') || 0),
      poids_moyen_g: Number(fd.get('poids_moyen_g') || 0),
      taille_moyenne_cm: fd.get('taille_moyenne_cm') ? Number(fd.get('taille_moyenne_cm')) : null,
      temperature_eau: fd.get('temperature_eau') ? Number(fd.get('temperature_eau')) : null,
      ph_eau: fd.get('ph_eau') ? Number(fd.get('ph_eau')) : null,
      intrants_utilises: fd.get('intrants_utilises') || null,
      quantite_recoltee_kg: fd.get('quantite_recoltee_kg') ? Number(fd.get('quantite_recoltee_kg')) : null,
      notes: fd.get('notes') || null,
    };

    const hors_ligne = isOfflineMode() || !navigator.onLine;
    if (hors_ligne) {
      const q = getQueue();
      q.push(releve);
      setQueue(q);
      showToast('Hors-ligne : relevé mis en file locale (IndexedDB/localStorage). Il sera synchronisé au retour du réseau.', 'warn');
      updateOfflineBanner(container);
      e.target.reset();
      return;
    }

    try {
      await Api.post('/production/sync', { releves: [releve] });
      showToast('Relevé synchronisé.', 'success');
      openRelevePanel(container, lot);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function offlineBanner() {
  return `<div class="offline-banner" id="offline-banner"></div>`;
}

async function syncQueue(container) {
  const q = getQueue();
  if (q.length === 0) return;
  try {
    await Api.post('/production/sync', { releves: q });
    setQueue([]);
    showToast(`${q.length} relevé(s) hors-ligne synchronisé(s).`, 'success');
  } catch (err) {
    showToast('Échec de synchronisation : ' + err.message, 'error');
  }
  updateOfflineBanner(container);
}

function updateOfflineBanner(container) {
  const banner = container.querySelector('#offline-banner');
  if (!banner) return;
  const q = getQueue();
  const offline = isOfflineMode() || !navigator.onLine;

  banner.classList.remove('hidden');
  banner.innerHTML = `
    <span>
      ${offline ? '📴 Mode hors-ligne (PWA offline-first) — les relevés sont mis en file locale.' : '🟢 En ligne.'}
      ${q.length ? ` ${q.length} relevé(s) en attente de synchronisation.` : ''}
    </span>
    <span style="display:flex;gap:8px;align-items:center">
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:11px">
        <input type="checkbox" id="toggle-offline" style="width:auto" ${isOfflineMode() ? 'checked' : ''} /> Simuler hors-ligne
      </label>
      ${q.length ? `<button id="btn-sync-now">Synchroniser maintenant</button>` : ''}
    </span>
  `;
  banner.querySelector('#toggle-offline').addEventListener('change', (e) => {
    localStorage.setItem(OFFLINE_MODE_KEY, e.target.checked ? '1' : '0');
    updateOfflineBanner(container);
  });
  const syncBtn = banner.querySelector('#btn-sync-now');
  if (syncBtn) syncBtn.addEventListener('click', () => syncQueue(container));
}

window.addEventListener('online', () => {
  const view = document.getElementById('view');
  if (view && view.querySelector('#offline-banner')) syncQueue(view);
});

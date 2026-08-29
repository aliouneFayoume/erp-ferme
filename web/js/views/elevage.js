window.Views = window.Views || {};

const ESPECE_LABEL = { BOVIN: 'Bovin', OVIN: 'Ovin', CAPRIN: 'Caprin' };
const ESPECE_ACCENT = { BOVIN: 'var(--bovin)', OVIN: 'var(--ovin)', CAPRIN: 'var(--caprin)' };
// Durée de gestation moyenne par espèce (jours) — estimation côté client pour pré-remplir la date de
// mise-bas prévue à la saisie d'une saillie, éditable ensuite ; jamais une règle stockée en base.
const GESTATION_JOURS = { BOVIN: 283, OVIN: 150, CAPRIN: 150 };
const ANIMAL_STATUT_BADGE = { VIVANT: 'ok', VENDU: 'info', ABATTU: 'muted', MORT: 'danger' };
const ANIMAL_STATUT_LABEL = { VIVANT: 'Vivant', VENDU: 'Vendu', ABATTU: 'Abattu', MORT: 'Mort' };
const RELEVE_TYPE_LABEL = { PESEE: 'Pesée', VACCINATION: 'Vaccination', TRAITEMENT: 'Traitement', OBSERVATION: 'Observation' };

function ageLabel(dateNaissance) {
  if (!dateNaissance) return 'âge inconnu';
  const naissance = new Date(dateNaissance);
  const maintenant = new Date();
  let mois = (maintenant.getFullYear() - naissance.getFullYear()) * 12 + (maintenant.getMonth() - naissance.getMonth());
  if (maintenant.getDate() < naissance.getDate()) mois -= 1;
  if (mois < 1) return "moins d'un mois";
  if (mois < 24) return `${mois} mois`;
  return `${Math.floor(mois / 12)} an(s)`;
}

window.Views.elevage = {
  async render(container) {
    const user = Api.getUser();
    const secteursTous = await Api.get('/production/secteurs');
    const secteursAutorises = secteursTous.filter(
      (s) => s.suivi_individuel && (user.role === 'admin' || !user.secteur_id || s.id === user.secteur_id)
    );

    if (secteursAutorises.length === 0) {
      container.innerHTML = `
        <div class="panel">
          <h2>Élevage</h2>
          <p class="empty">Aucun secteur d'élevage individuel (Bovins/Ovins/Caprins) n'est encore configuré pour votre ferme. Contactez le support Massla pour l'ajouter.</p>
        </div>
      `;
      return;
    }

    const [animaux, gestations] = await Promise.all([
      Api.get('/elevage/animaux'),
      Api.get('/elevage/reproductions?statut=EN_COURS'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvel animal</h2>
        <p class="desc" style="margin-bottom:0">Enregistrer un animal acheté ou né sur la ferme</p>
        <form id="form-animal" class="form-grid" autocomplete="off">
          <label>Secteur
            <select name="secteur_id" id="select-secteur-animal" required>
              ${secteursAutorises.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Identifiant (boucle)<input type="text" name="identifiant" placeholder="ex: BOV-0042" required /></label>
          <label>Espèce
            <select name="espece" id="select-espece-animal" required>
              <option value="BOVIN">Bovin</option>
              <option value="OVIN">Ovin</option>
              <option value="CAPRIN">Caprin</option>
            </select>
          </label>
          <label>Race (optionnel)<input type="text" name="race" /></label>
          <label>Sexe
            <select name="sexe" required><option value="F">Femelle</option><option value="M">Mâle</option></select>
          </label>
          <label>Date de naissance<input type="date" name="date_naissance" /></label>
          <label>Origine
            <select name="origine" id="select-origine-animal">
              <option value="ACHETE">Acheté</option>
              <option value="NE_FERME">Né sur la ferme</option>
            </select>
          </label>
          <label id="champ-mere-animal" class="hidden">Mère
            <select name="mere_id" id="select-mere-animal"><option value="">—</option></select>
          </label>
          <label>Poids initial (kg)<input type="number" name="poids_initial_kg" min="0" step="0.1" /></label>
          <button type="submit">Ajouter l'animal</button>
        </form>
      </div>

      ${
        gestations.length
          ? `<div class="panel">
              <h2>Gestations en cours (${gestations.length})</h2>
              <div class="card-list" id="gestations-list"></div>
            </div>`
          : ''
      }

      <div class="panel">
        <div class="panel-row">
          <h2>Animaux</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <select id="filtre-secteur">
              <option value="">Tous secteurs</option>
              ${secteursAutorises.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
            <select id="filtre-espece">
              <option value="">Toutes espèces</option>
              <option value="BOVIN">Bovin</option><option value="OVIN">Ovin</option><option value="CAPRIN">Caprin</option>
            </select>
            <select id="filtre-statut">
              <option value="">Vivants</option>
              <option value="TOUS">Tous statuts</option>
              <option value="VENDU">Vendus</option><option value="ABATTU">Abattus</option><option value="MORT">Morts</option>
            </select>
          </div>
        </div>
        <div class="card-list" id="animaux-list"></div>
      </div>

      <div class="panel hidden" id="animal-panel"></div>
    `;

    renderAnimauxList(container, animaux);
    if (gestations.length) renderGestationsList(container, gestations);

    const selectSecteurForm = container.querySelector('#select-secteur-animal');
    const selectEspeceForm = container.querySelector('#select-espece-animal');
    const selectOrigine = container.querySelector('#select-origine-animal');
    const champMere = container.querySelector('#champ-mere-animal');
    const selectMere = container.querySelector('#select-mere-animal');

    function rafraichirMeres() {
      if (selectOrigine.value !== 'NE_FERME') {
        champMere.classList.add('hidden');
        return;
      }
      champMere.classList.remove('hidden');
      const meres = animaux.filter(
        (a) => String(a.secteur_id) === String(selectSecteurForm.value) && a.espece === selectEspeceForm.value && a.sexe === 'F' && a.statut === 'VIVANT'
      );
      selectMere.innerHTML = '<option value="">—</option>' + meres.map((m) => `<option value="${m.id}">${esc(m.identifiant)}</option>`).join('');
    }
    selectOrigine.addEventListener('change', rafraichirMeres);
    selectSecteurForm.addEventListener('change', rafraichirMeres);
    selectEspeceForm.addEventListener('change', rafraichirMeres);
    rafraichirMeres();

    container.querySelector('#form-animal').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/elevage/animaux', {
          secteur_id: Number(fd.get('secteur_id')),
          identifiant: fd.get('identifiant'),
          espece: fd.get('espece'),
          race: fd.get('race') || null,
          sexe: fd.get('sexe'),
          date_naissance: fd.get('date_naissance') || null,
          origine: fd.get('origine'),
          mere_id: fd.get('mere_id') ? Number(fd.get('mere_id')) : null,
          poids_initial_kg: fd.get('poids_initial_kg') ? Number(fd.get('poids_initial_kg')) : null,
        });
        showToast('Animal ajouté.', 'success');
        window.Views.elevage.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    ['#filtre-secteur', '#filtre-espece', '#filtre-statut'].forEach((sel) => {
      container.querySelector(sel).addEventListener('change', async () => {
        const params = new URLSearchParams();
        const secteurId = container.querySelector('#filtre-secteur').value;
        const espece = container.querySelector('#filtre-espece').value;
        const statut = container.querySelector('#filtre-statut').value;
        if (secteurId) params.set('secteur_id', secteurId);
        if (espece) params.set('espece', espece);
        if (statut) params.set('statut', statut);
        const filtres = await Api.get(`/elevage/animaux?${params.toString()}`);
        renderAnimauxList(container, filtres);
      });
    });
  },
};

function renderAnimauxList(container, animaux) {
  const list = container.querySelector('#animaux-list');
  if (!animaux.length) {
    list.innerHTML = '<div class="empty">Aucun animal.</div>';
    return;
  }
  list.innerHTML = animaux
    .map(
      (a) => `
      <div class="lot-card">
        <span class="tag-secteur" style="background:${ESPECE_ACCENT[a.espece] || '#888'}">${esc(ESPECE_LABEL[a.espece] || a.espece)}</span>
        <span class="badge ${ANIMAL_STATUT_BADGE[a.statut] || 'muted'}" style="float:right">${ANIMAL_STATUT_LABEL[a.statut] || esc(a.statut)}</span>
        <div class="code" style="margin-top:8px">${esc(a.identifiant)}${a.race ? ` — ${esc(a.race)}` : ''}</div>
        <div class="meta">${a.sexe === 'F' ? 'Femelle' : 'Mâle'} · ${esc(a.secteur_nom)} · ${ageLabel(a.date_naissance)}</div>
        <button class="secondary" style="margin-top:10px;width:100%" data-animal-id="${a.id}">Voir la fiche</button>
      </div>
    `
    )
    .join('');
  list.querySelectorAll('button[data-animal-id]').forEach((btn) => {
    btn.addEventListener('click', () => openAnimalPanel(container, Number(btn.dataset.animalId)));
  });
}

function renderGestationsList(container, gestations) {
  const list = container.querySelector('#gestations-list');
  if (!list) return;
  list.innerHTML = gestations
    .map(
      (g) => `
      <div class="lot-card">
        <div class="code">Mère : ${esc(g.mere_identifiant)}</div>
        <div class="meta">Saillie le ${fmtDate(g.date_saillie)}${g.date_mise_bas_prevue ? ` · mise-bas prévue le ${fmtDate(g.date_mise_bas_prevue)}` : ''}</div>
        <button class="secondary" style="margin-top:10px;width:100%" data-mise-bas="${g.id}">Enregistrer la mise-bas</button>
      </div>
    `
    )
    .join('');
  list.querySelectorAll('button[data-mise-bas]').forEach((btn) => {
    btn.addEventListener('click', () => ouvrirMiseBas(container, btn.dataset.miseBas));
  });
}

async function ouvrirMiseBas(container, reproductionId) {
  const infos = await Modal.open('Mise-bas', [
    { name: 'date_mise_bas_reelle', label: 'Date de mise-bas', type: 'date', value: new Date().toISOString().slice(0, 10) },
    { name: 'nombre_petits', label: 'Nombre de petits', type: 'number', value: '1' },
  ]);
  if (!infos || !infos.nombre_petits) return;
  const n = Number(infos.nombre_petits);
  if (!(n > 0)) {
    showToast('Nombre de petits invalide.', 'error');
    return;
  }

  const petits = [];
  for (let i = 1; i <= n; i++) {
    const petit = await Modal.open(`Petit ${i}/${n}`, [
      { name: 'identifiant', label: 'Identifiant', type: 'text', value: '' },
      {
        name: 'sexe', label: 'Sexe', type: 'select', value: 'F',
        options: [{ value: 'F', label: 'Femelle' }, { value: 'M', label: 'Mâle' }],
      },
      { name: 'poids_initial_kg', label: 'Poids à la naissance (kg)', type: 'number', value: '' },
    ]);
    if (!petit || !petit.identifiant) {
      showToast('Mise-bas annulée : identifiant manquant.', 'error');
      return;
    }
    petits.push({ identifiant: petit.identifiant, sexe: petit.sexe, poids_initial_kg: petit.poids_initial_kg ? Number(petit.poids_initial_kg) : null });
  }

  try {
    await Api.put(`/elevage/reproductions/${reproductionId}/mise-bas`, { date_mise_bas_reelle: infos.date_mise_bas_reelle, petits });
    showToast(`${petits.length} petit(s) enregistré(s).`, 'success');
    window.Views.elevage.render(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function ouvrirSaillie(container, mere) {
  const memeSecteurEspece = await Api.get(`/elevage/animaux?secteur_id=${mere.secteur_id}&espece=${mere.espece}`);
  const males = memeSecteurEspece.filter((a) => a.sexe === 'M' && a.statut === 'VIVANT');
  const values = await Modal.open(`Enregistrer une saillie — ${mere.identifiant}`, [
    { name: 'date_saillie', label: 'Date de saillie', type: 'date', value: new Date().toISOString().slice(0, 10) },
    {
      name: 'pere_id', label: 'Père (optionnel)', type: 'select', value: '',
      options: [{ value: '', label: '—' }, ...males.map((m) => ({ value: String(m.id), label: m.identifiant }))],
    },
  ]);
  if (!values) return;

  const joursGestation = GESTATION_JOURS[mere.espece] || 150;
  const prevue = new Date(values.date_saillie);
  prevue.setUTCDate(prevue.getUTCDate() + joursGestation);

  try {
    await Api.post('/elevage/reproductions', {
      mere_id: mere.id,
      pere_id: values.pere_id ? Number(values.pere_id) : null,
      date_saillie: values.date_saillie,
      date_mise_bas_prevue: prevue.toISOString().slice(0, 10),
    });
    showToast('Saillie enregistrée.', 'success');
    window.Views.elevage.render(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openAnimalPanel(container, animalId) {
  const panel = container.querySelector('#animal-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="empty">Chargement…</div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const [animal, releves] = await Promise.all([
    Api.get(`/elevage/animaux/${animalId}`),
    Api.get(`/elevage/animaux/${animalId}/releves`),
  ]);

  const courbePoids = releves
    .filter((r) => r.type_evenement === 'PESEE' && Number(r.poids_kg) > 0)
    .map((r) => ({ date: r.date_releve, value: Number(r.poids_kg) }))
    .reverse();

  let gestationEnCours = null;
  if (animal.sexe === 'F') {
    const gestations = await Api.get(`/elevage/reproductions?mere_id=${animal.id}&statut=EN_COURS`);
    gestationEnCours = gestations[0] || null;
  }

  panel.innerHTML = `
    <div class="panel-row">
      <h2>${esc(animal.identifiant)} — ${esc(ESPECE_LABEL[animal.espece] || animal.espece)}</h2>
      <button class="secondary" id="close-animal">Fermer</button>
    </div>
    <div class="pill-row">
      <span class="pill">${animal.sexe === 'F' ? 'Femelle' : 'Mâle'}</span>
      <span class="pill">${esc(animal.secteur_nom)}</span>
      <span class="pill">${ageLabel(animal.date_naissance)}</span>
      <span class="pill">${animal.origine === 'NE_FERME' ? 'Né sur la ferme' : 'Acheté'}</span>
      <span class="badge ${ANIMAL_STATUT_BADGE[animal.statut] || 'muted'}">${ANIMAL_STATUT_LABEL[animal.statut] || esc(animal.statut)}</span>
    </div>

    ${
      courbePoids.length >= 2
        ? `<div style="margin-top:14px">
            <div class="desc" style="margin-bottom:4px">Courbe de poids (kg)</div>
            ${lineChartSvg(courbePoids, { color: ESPECE_ACCENT[animal.espece] || '#5B8C3A', unit: 'kg' })}
          </div>`
        : ''
    }

    <div style="margin-top:16px">
      <h3 style="margin-bottom:8px">Généalogie</h3>
      <p class="desc">Mère : ${animal.mere ? esc(animal.mere.identifiant) : 'inconnue / achetée'}</p>
      <p class="desc">Descendance : ${animal.petits.length ? animal.petits.map((p) => esc(p.identifiant)).join(', ') : 'aucune'}</p>
    </div>

    ${
      animal.statut === 'VIVANT'
        ? `<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            ${animal.sexe === 'F' && !gestationEnCours ? `<button class="secondary" id="btn-saillie">Enregistrer une saillie</button>` : ''}
            ${gestationEnCours ? `<span class="badge info">Gestation en cours depuis le ${fmtDate(gestationEnCours.date_saillie)}</span>` : ''}
            <select id="select-nouveau-statut">
              <option value="VENDU">Vendu</option>
              <option value="ABATTU">Abattu</option>
              <option value="MORT">Mort</option>
            </select>
            <button class="secondary" id="btn-changer-statut">Changer le statut</button>
          </div>`
        : `<p class="desc" style="margin-top:16px">Statut : ${ANIMAL_STATUT_LABEL[animal.statut]}${animal.date_sortie ? ` le ${fmtDate(animal.date_sortie)}` : ''}.</p>`
    }

    ${
      animal.statut === 'VIVANT'
        ? `<form id="form-releve" class="form-grid" autocomplete="off" style="margin-top:16px">
            <label>Date<input type="date" name="date_releve" required value="${new Date().toISOString().slice(0, 10)}" /></label>
            <label>Type
              <select name="type_evenement" id="select-type-releve">
                <option value="PESEE">Pesée</option>
                <option value="VACCINATION">Vaccination</option>
                <option value="TRAITEMENT">Traitement</option>
                <option value="OBSERVATION">Observation</option>
              </select>
            </label>
            <label id="champ-poids-releve">Poids (kg)<input type="number" name="poids_kg" min="0" step="0.1" /></label>
            <label id="champ-produit-releve" class="hidden">Produit utilisé<input type="text" name="produit_utilise" /></label>
            <label>Notes<input type="text" name="notes" /></label>
            <button type="submit">Enregistrer le relevé</button>
          </form>`
        : ''
    }

    <table style="margin-top:18px">
      <thead><tr><th>Date</th><th>Type</th><th>Détail</th></tr></thead>
      <tbody>
        ${
          releves.length
            ? releves
                .map(
                  (r) => `<tr>
                    <td>${fmtDate(r.date_releve)}</td>
                    <td>${RELEVE_TYPE_LABEL[r.type_evenement] || esc(r.type_evenement)}</td>
                    <td>${[r.poids_kg ? `${fmt(r.poids_kg)} kg` : '', r.produit_utilise ? esc(r.produit_utilise) : '', r.notes ? esc(r.notes) : ''].filter(Boolean).join(' · ') || '-'}</td>
                  </tr>`
                )
                .join('')
            : '<tr><td colspan="3" class="empty">Aucun relevé.</td></tr>'
        }
      </tbody>
    </table>
  `;

  panel.querySelector('#close-animal').addEventListener('click', () => panel.classList.add('hidden'));

  const selectType = panel.querySelector('#select-type-releve');
  if (selectType) {
    const champPoids = panel.querySelector('#champ-poids-releve');
    const champProduit = panel.querySelector('#champ-produit-releve');
    selectType.addEventListener('change', () => {
      champPoids.classList.toggle('hidden', selectType.value !== 'PESEE');
      champProduit.classList.toggle('hidden', !['VACCINATION', 'TRAITEMENT'].includes(selectType.value));
    });
  }

  const formReleve = panel.querySelector('#form-releve');
  if (formReleve) {
    formReleve.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post(`/elevage/animaux/${animal.id}/releves`, {
          date_releve: fd.get('date_releve'),
          type_evenement: fd.get('type_evenement'),
          poids_kg: fd.get('poids_kg') ? Number(fd.get('poids_kg')) : null,
          produit_utilise: fd.get('produit_utilise') || null,
          notes: fd.get('notes') || null,
        });
        showToast('Relevé enregistré.', 'success');
        openAnimalPanel(container, animal.id);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const btnSaillie = panel.querySelector('#btn-saillie');
  if (btnSaillie) btnSaillie.addEventListener('click', () => ouvrirSaillie(container, animal));

  const btnStatut = panel.querySelector('#btn-changer-statut');
  if (btnStatut) {
    btnStatut.addEventListener('click', async () => {
      const statut = panel.querySelector('#select-nouveau-statut').value;
      const confirmation = await Modal.open('Confirmer le changement de statut', [
        { name: 'confirmer', label: `Tapez "OUI" pour confirmer (${ANIMAL_STATUT_LABEL[statut]})`, type: 'text', value: '' },
      ]);
      if (!confirmation || confirmation.confirmer.trim().toUpperCase() !== 'OUI') return;
      try {
        await Api.put(`/elevage/animaux/${animal.id}/statut`, { statut });
        showToast('Statut mis à jour.', 'success');
        openAnimalPanel(container, animal.id);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

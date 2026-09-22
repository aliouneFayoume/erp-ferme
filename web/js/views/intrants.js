window.Views = window.Views || {};

const INTRANT_CATEGORIES = ['Aliment', 'Engrais', 'Phytosanitaire', 'Vétérinaire', 'Semences', 'Autre'];

window.Views.intrants = {
  async render(container) {
    const [intrants, secteurs] = await Promise.all([Api.get('/intrants'), Api.get('/production/secteurs')]);
    // Un aliment par défaut se règle sur le secteur qui porte réellement les lots. Pour une ferme à
    // sous-secteurs (ex. Piscicole > Éclosion / Élevage larvaire / Pregrossissement), ce sont les
    // SOUS-secteurs : chaque type de bassin peut avoir son propre aliment, utilisés le même jour. Le
    // secteur parent garde un réglage de repli, utilisé par les sous-secteurs qui n'ont pas le leur
    // (même règle côté serveur, routes/production.js). Les secteurs à suivi individuel (bovins…)
    // n'ont pas d'aliment par défaut.
    const secteursEligibles = secteurs.filter((s) => !s.suivi_individuel);
    const lignesAliment = [];
    for (const racine of secteursEligibles.filter((s) => !s.parent_secteur_id)) {
      const enfants = secteursEligibles.filter((s) => s.parent_secteur_id === racine.id);
      lignesAliment.push({ secteur: racine, enfant: false, aEnfants: enfants.length > 0 });
      for (const e of enfants) lignesAliment.push({ secteur: e, enfant: true, aEnfants: false });
    }
    const parId = new Map(secteurs.map((s) => [s.id, s]));
    // Aliment réellement appliqué aux lots d'un secteur : le sien, sinon celui de son parent.
    const alimentEffectif = (s) => s.intrant_alimentation_id ?? parId.get(s.parent_secteur_id)?.intrant_alimentation_id ?? null;
    // Secteurs qui portent des lots (feuilles) — ceux dont on veut savoir quel aliment ils consomment.
    const secteursAvecLots = lignesAliment.filter((l) => !l.aEnfants).map((l) => l.secteur);
    const utilisePar = (intrantId) =>
      secteursAvecLots
        .filter((s) => Number(alimentEffectif(s)) === intrantId)
        .map((s) => ({ nom: s.nom, herite: s.intrant_alimentation_id == null }));

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvel intrant</h2>
        <form id="form-intrant" class="form-grid" autocomplete="off">
          <label>Nom<input type="text" name="nom" required placeholder="ex: Aliment ponte, Engrais NPK 15-15-15" /></label>
          <label>Catégorie
            <select name="categorie">
              <option value="">—</option>
              ${INTRANT_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </label>
          <label>Unité<input type="text" name="unite" required placeholder="kg, L, sac, dose..." /></label>
          <label>Secteur (optionnel)
            <select name="secteur_id">
              <option value="">—</option>
              ${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Stock initial<input type="number" name="quantite_initiale" min="0" step="0.01" value="0" /></label>
          <label>Seuil d'alerte (optionnel)<input type="number" name="seuil_alerte" min="0" step="0.01" /></label>
          <button type="submit">Créer l'intrant</button>
        </form>
      </div>

      <div class="panel">
        <h2>Stock d'intrants (${intrants.length})</h2>
        <p class="desc">L'aliment consommé saisi dans un relevé journalier est déduit automatiquement du stock de l'aliment lié au type de bassin du lot (colonne « Aliment de ») — à régler dans le panneau ci-dessous. Renseignez un seuil d'alerte par aliment : le stock passe en orange dès qu'il est atteint.</p>
        <table>
          <thead><tr><th>Nom</th><th>Catégorie</th><th>Secteur</th><th>Aliment de</th><th>Stock</th><th></th></tr></thead>
          <tbody>
            ${intrants
              .map((i) => {
                const stockNum = Number(i.quantite_stock);
                const bas = i.seuil_alerte != null && stockNum <= Number(i.seuil_alerte);
                const negatif = stockNum < 0;
                const classe = negatif ? 'danger' : bas ? 'warn' : 'ok';
                return `<tr>
                  <td>${esc(i.nom)}</td>
                  <td>${i.categorie ? esc(i.categorie) : '-'}</td>
                  <td>${i.secteur_nom ? esc(i.secteur_nom) : '-'}</td>
                  <td>${
                    utilisePar(i.id).length
                      ? utilisePar(i.id)
                          .map((u) => `<span class="badge muted" title="${u.herite ? 'Repris du secteur parent' : 'Aliment propre à ce type de bassin'}">${esc(u.nom)}${u.herite ? ' ↑' : ''}</span>`)
                          .join(' ')
                      : '<span class="desc">—</span>'
                  }</td>
                  <td class="num"><span class="badge ${classe}">${fmt(stockNum)} ${esc(i.unite)}</span></td>
                  <td style="white-space:nowrap">
                    <button class="secondary" data-entree="${i.id}">+ Entrée</button>
                    <button class="secondary" data-sortie="${i.id}">− Sortie</button>
                    <button class="secondary" data-historique="${i.id}" data-nom="${esc(i.nom)}">Historique</button>
                    <button class="secondary" data-modifier="${i.id}">Modifier</button>
                    <button class="danger" data-supprimer="${i.id}" data-nom="${esc(i.nom)}">Supprimer</button>
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
        ${intrants.length === 0 ? '<p class="empty">Aucun intrant enregistré.</p>' : ''}
      </div>

      <div class="panel">
        <h2>Aliment par défaut par secteur et type de bassin</h2>
        <p class="desc">Chaque type de bassin (sous-secteur) peut avoir son propre aliment : les relevés de chacun déduisent alors le bon stock, même si plusieurs aliments sont utilisés le même jour. Le secteur parent sert de repli aux types de bassin qui n'ont pas le leur.</p>
        <table>
          <thead><tr><th>Secteur / type de bassin</th><th>Aliment par défaut</th><th></th></tr></thead>
          <tbody>
            ${lignesAliment
              .map(
                (l) => `<tr>
                  <td>${l.enfant ? '<span class="desc" style="margin-left:14px">↳</span> ' : ''}${esc(l.secteur.nom)}${
                    l.aEnfants ? '<div class="desc" style="margin:2px 0 0">Repli pour ses types de bassin sans aliment propre</div>' : ''
                  }</td>
                  <td>
                    <select class="select-aliment-defaut" data-secteur="${l.secteur.id}" style="max-width:280px">
                      <option value="">Aucun</option>
                      ${intrants
                        .map((i) => `<option value="${i.id}" ${Number(l.secteur.intrant_alimentation_id) === i.id ? 'selected' : ''}>${esc(i.nom)}</option>`)
                        .join('')}
                    </select>
                  </td>
                  <td><button class="secondary btn-enregistrer-aliment-defaut" data-secteur="${l.secteur.id}">Enregistrer</button></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${lignesAliment.length === 0 ? '<p class="empty">Aucun secteur éligible.</p>' : ''}
      </div>

      <div id="historique-panel" class="panel hidden"></div>
    `;

    container.querySelector('#form-intrant').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/intrants', {
          nom: fd.get('nom'),
          categorie: fd.get('categorie') || null,
          unite: fd.get('unite'),
          secteur_id: fd.get('secteur_id') || null,
          quantite_initiale: Number(fd.get('quantite_initiale') || 0),
          seuil_alerte: fd.get('seuil_alerte') || null,
        });
        showToast('Intrant créé.', 'success');
        window.Views.intrants.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-entree]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const values = await Modal.open('Entrée de stock', [
          { name: 'quantite', label: 'Quantité reçue', type: 'number', value: '' },
          { name: 'notes', label: 'Notes (optionnel)', type: 'text', value: '' },
        ]);
        if (!values || !(Number(values.quantite) > 0)) return;
        try {
          await Api.post(`/intrants/${btn.dataset.entree}/entree`, { quantite: Number(values.quantite), notes: values.notes });
          showToast('Entrée enregistrée.', 'success');
          window.Views.intrants.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-sortie]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const values = await Modal.open('Sortie de stock', [
          { name: 'quantite', label: 'Quantité utilisée', type: 'number', value: '' },
          { name: 'notes', label: 'Notes (optionnel)', type: 'text', value: '' },
        ]);
        if (!values || !(Number(values.quantite) > 0)) return;
        try {
          await Api.post(`/intrants/${btn.dataset.sortie}/sortie`, { quantite: Number(values.quantite), notes: values.notes });
          showToast('Sortie enregistrée.', 'success');
          window.Views.intrants.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-modifier]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const intrant = intrants.find((i) => i.id === Number(btn.dataset.modifier));
        const values = await Modal.open('Modifier l\'intrant', [
          { name: 'nom', label: 'Nom', type: 'text', value: intrant.nom },
          {
            name: 'categorie',
            label: 'Catégorie',
            type: 'select',
            value: intrant.categorie || '',
            options: [{ value: '', label: '—' }, ...INTRANT_CATEGORIES.map((c) => ({ value: c, label: c }))],
          },
          { name: 'unite', label: 'Unité', type: 'text', value: intrant.unite },
          { name: 'seuil_alerte', label: "Seuil d'alerte", type: 'number', value: intrant.seuil_alerte ?? '' },
        ]);
        if (!values) return;
        try {
          await Api.put(`/intrants/${intrant.id}`, { ...values, secteur_id: intrant.secteur_id });
          showToast('Intrant mis à jour.', 'success');
          window.Views.intrants.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const values = await Modal.open(`Supprimer ${btn.dataset.nom} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/intrants/${btn.dataset.supprimer}`);
          showToast('Intrant supprimé.', 'success');
          window.Views.intrants.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-historique]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const panel = container.querySelector('#historique-panel');
        panel.classList.remove('hidden');
        panel.innerHTML = '<div class="empty">Chargement…</div>';
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        const mouvements = await Api.get(`/intrants/${btn.dataset.historique}/mouvements`);
        panel.innerHTML = `
          <h2>Historique — ${esc(btn.dataset.nom)}</h2>
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Quantité</th><th>Motif</th><th>Lot / type de bassin</th><th>Notes</th></tr></thead>
            <tbody>
              ${mouvements
                .map(
                  (m) => `<tr>
                    <td>${fmtDate(m.cree_le)}</td>
                    <td><span class="badge ${m.type === 'ENTREE' ? 'ok' : 'warn'}">${m.type === 'ENTREE' ? 'Entrée' : 'Sortie'}</span></td>
                    <td class="num">${fmt(m.quantite)}</td>
                    <td>${esc(m.motif)}</td>
                    <td>${m.code_lot ? `${esc(m.code_lot)}${m.secteur_nom ? ` <span class="desc">(${esc(m.secteur_nom)})</span>` : ''}` : '-'}</td>
                    <td>${m.notes ? esc(m.notes) : '-'}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
          ${mouvements.length === 0 ? '<p class="empty">Aucun mouvement.</p>' : ''}
        `;
      });
    });

    container.querySelectorAll('.btn-enregistrer-aliment-defaut').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const select = container.querySelector(`.select-aliment-defaut[data-secteur="${btn.dataset.secteur}"]`);
        try {
          await Api.put(`/production/secteurs/${btn.dataset.secteur}/aliment-defaut`, { intrant_id: select.value || null });
          showToast('Aliment par défaut enregistré.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

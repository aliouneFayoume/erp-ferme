window.Views = window.Views || {};

window.Views.materiel = {
  async render(container) {
    const [equipements, secteurs, fournisseurs] = await Promise.all([
      Api.get('/materiel'),
      Api.get('/production/secteurs'),
      Api.get('/fournisseurs'),
    ]);
    const moi = Api.getUser();
    const aujourdhui = new Date().toISOString().slice(0, 10);

    const enRetard = equipements.filter((e) => e.prochain_entretien && e.prochain_entretien.slice(0, 10) < aujourdhui);

    container.innerHTML = `
      ${
        enRetard.length
          ? `<div class="panel alert-panel">
              <h2>⚠ Entretiens en retard</h2>
              <ul class="alert-list">
                ${enRetard.map((e) => `<li>${esc(e.nom)} — entretien prévu le ${fmtDate(e.prochain_entretien)}</li>`).join('')}
              </ul>
            </div>`
          : ''
      }

      <div class="panel">
        <h2>Nouvel équipement</h2>
        <form id="form-equipement" class="form-grid">
          <label>Nom<input type="text" name="nom" required /></label>
          <label>Catégorie
            <select name="categorie">
              <option value="Motoculture">Motoculture</option>
              <option value="Irrigation">Irrigation</option>
              <option value="Transport">Transport</option>
              <option value="Avicole">Avicole</option>
              <option value="Piscicole">Piscicole</option>
              <option value="Autre">Autre</option>
            </select>
          </label>
          <label>Secteur (optionnel)
            <select name="secteur_id">
              <option value="">— Partagé / non rattaché —</option>
              ${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Fournisseur (optionnel)
            <select name="fournisseur_id">
              <option value="">— Inconnu —</option>
              ${fournisseurs.map((f) => `<option value="${f.id}">${esc(f.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Quantité<input type="number" name="quantite" min="1" value="1" /></label>
          <label>Date d'achat<input type="date" name="date_achat" /></label>
          <label>Valeur d'achat (FCFA)<input type="number" name="valeur_achat" min="0" step="0.01" /></label>
          <label>Notes<input type="text" name="notes" /></label>
          <button type="submit">Ajouter l'équipement</button>
        </form>
      </div>

      <div class="panel">
        <h2>Matériel (${equipements.length})</h2>
        <table>
          <thead><tr><th>Nom</th><th>Catégorie</th><th>Secteur</th><th>État</th><th>Qté</th><th>Fournisseur</th><th>Prochain entretien</th><th></th></tr></thead>
          <tbody>
            ${equipements
              .map((e) => {
                const retard = e.prochain_entretien && e.prochain_entretien.slice(0, 10) < aujourdhui;
                return `<tr>
                  <td>${esc(e.nom)}</td>
                  <td>${esc(e.categorie) || '-'}</td>
                  <td>${esc(e.secteur_nom) || '-'}</td>
                  <td>${etatBadge(e.etat)}</td>
                  <td class="num">${e.quantite}</td>
                  <td>${esc(e.fournisseur_nom) || '-'}</td>
                  <td>${e.prochain_entretien ? `<span class="badge ${retard ? 'danger' : 'ok'}">${fmtDate(e.prochain_entretien)}</span>` : '-'}</td>
                  <td class="actions-cell">
                    <button class="secondary" data-modifier="${e.id}">Modifier</button>
                    <button class="secondary" data-entretien="${e.id}">Entretien</button>
                    <button class="secondary" data-historique="${e.id}">Historique</button>
                    ${moi.role === 'admin' ? `<button class="danger" data-supprimer="${e.id}">Supprimer</button>` : ''}
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
        ${equipements.length === 0 ? '<p class="empty">Aucun équipement enregistré.</p>' : ''}
      </div>

      <div class="panel">
        <h2>Historique d'entretien</h2>
        <div id="historique-zone"><p class="empty">Cliquez sur "Historique" pour un équipement ci-dessus.</p></div>
      </div>
    `;

    container.querySelector('#form-equipement').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/materiel', {
          nom: fd.get('nom'),
          categorie: fd.get('categorie'),
          secteur_id: fd.get('secteur_id') || null,
          fournisseur_id: fd.get('fournisseur_id') || null,
          quantite: Number(fd.get('quantite')) || 1,
          date_achat: fd.get('date_achat') || null,
          valeur_achat: fd.get('valeur_achat') || null,
          notes: fd.get('notes'),
        });
        showToast('Équipement ajouté.', 'success');
        window.Views.materiel.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-modifier]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.modifier));
        const values = await Modal.open(`Modifier ${eq.nom}`, [
          { name: 'nom', label: 'Nom', type: 'text', value: eq.nom },
          { name: 'categorie', label: 'Catégorie', type: 'text', value: eq.categorie || '' },
          {
            name: 'etat', label: 'État', type: 'select', value: eq.etat,
            options: ['Bon', 'A réparer', 'Hors service'].map((v) => ({ value: v, label: v })),
          },
          { name: 'quantite', label: 'Quantité', type: 'number', value: eq.quantite },
          { name: 'notes', label: 'Notes', type: 'text', value: eq.notes || '' },
        ]);
        if (!values) return;
        try {
          await Api.put(`/materiel/${eq.id}`, { ...values, quantite: Number(values.quantite) || eq.quantite });
          showToast('Équipement mis à jour.', 'success');
          window.Views.materiel.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-entretien]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.entretien));
        const values = await Modal.open(`Nouvel entretien — ${eq.nom}`, [
          { name: 'date_entretien', label: "Date de l'entretien", type: 'date', value: aujourdhui },
          { name: 'description', label: 'Description', type: 'text', value: '' },
          { name: 'cout', label: 'Coût (FCFA, optionnel — génère une dépense)', type: 'number', value: '' },
          { name: 'prochain_entretien', label: 'Prochain entretien prévu (optionnel)', type: 'date', value: '' },
        ]);
        if (!values || !values.date_entretien) return;
        try {
          await Api.post(`/materiel/${eq.id}/entretiens`, {
            date_entretien: values.date_entretien,
            description: values.description,
            cout: values.cout || null,
            prochain_entretien: values.prochain_entretien || null,
          });
          showToast(
            values.cout ? 'Entretien enregistré et dépense créée.' : 'Entretien enregistré.',
            'success'
          );
          window.Views.materiel.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-historique]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.historique));
        const zone = container.querySelector('#historique-zone');
        zone.innerHTML = '<div class="empty">Chargement…</div>';
        try {
          const entretiens = await Api.get(`/materiel/${eq.id}/entretiens`);
          zone.innerHTML = `
            <h3>${esc(eq.nom)}</h3>
            ${
              entretiens.length === 0
                ? '<p class="empty">Aucun entretien enregistré.</p>'
                : `<table>
                    <thead><tr><th>Date</th><th>Description</th><th>Coût</th><th>Prochain entretien</th></tr></thead>
                    <tbody>
                      ${entretiens
                        .map(
                          (h) => `<tr>
                            <td>${fmtDate(h.date_entretien)}</td>
                            <td>${esc(h.description) || '-'}</td>
                            <td class="num">${h.cout ? `${fmt(h.cout)} FCFA` : '-'}</td>
                            <td>${fmtDate(h.prochain_entretien)}</td>
                          </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>`
            }
          `;
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.supprimer));
        const values = await Modal.open(`Supprimer ${eq.nom} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/materiel/${eq.id}`);
          showToast('Équipement supprimé.', 'success');
          window.Views.materiel.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

function etatBadge(etat) {
  const map = { Bon: 'ok', 'A réparer': 'warn', 'Hors service': 'danger' };
  return `<span class="badge ${map[etat] || 'muted'}">${etat}</span>`;
}

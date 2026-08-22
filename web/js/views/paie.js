window.Views = window.Views || {};

function moisCourantPaie() {
  return new Date().toISOString().slice(0, 7);
}

function statutBulletinBadge(statut) {
  return statut === 'PAYE' ? '<span class="badge ok">Payé</span>' : '<span class="badge warn">En attente</span>';
}

window.Views.paie = {
  async render(container) {
    const mois = container.dataset.moisPaie || moisCourantPaie();
    const [employes, secteurs, bulletins] = await Promise.all([
      Api.get('/paie/employes'),
      Api.get('/production/secteurs'),
      Api.get(`/paie/bulletins?periode=${mois}`),
    ]);
    const moi = Api.getUser();
    const employesActifs = employes.filter((e) => e.actif);
    const employesSansBulletin = employesActifs.filter((e) => !bulletins.some((b) => b.employe_id === e.id));

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvel employé</h2>
        <form id="form-employe" class="form-grid">
          <label>Nom complet<input type="text" name="nom_complet" required /></label>
          <label>Poste<input type="text" name="poste" /></label>
          <label>Secteur (optionnel)
            <select name="secteur_id">
              <option value="">— Personnel général —</option>
              ${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Téléphone<input type="text" name="telephone" /></label>
          <label>Date d'embauche<input type="date" name="date_embauche" /></label>
          <label>Salaire brut mensuel (FCFA)<input type="number" name="salaire_brut_mensuel" min="0" step="0.01" /></label>
          <button type="submit">Ajouter l'employé</button>
        </form>
      </div>

      <div class="panel">
        <h2>Employés (${employesActifs.length} actif(s))</h2>
        <table>
          <thead><tr><th>Nom</th><th>Poste</th><th>Secteur</th><th>Salaire brut mensuel</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${employes
              .map(
                (e) => `<tr>
                  <td>${esc(e.nom_complet)}</td>
                  <td>${esc(e.poste) || '-'}</td>
                  <td>${esc(e.secteur_nom) || '-'}</td>
                  <td class="num">${e.salaire_brut_mensuel ? `${fmt(e.salaire_brut_mensuel)} FCFA` : '-'}</td>
                  <td>${e.actif ? '<span class="badge ok">Actif</span>' : '<span class="badge muted">Inactif</span>'}</td>
                  <td class="actions-cell">
                    <button class="secondary" data-modifier-employe="${e.id}">Modifier</button>
                    ${moi.role === 'admin' ? `<button class="danger" data-supprimer-employe="${e.id}">Supprimer</button>` : ''}
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${employes.length === 0 ? '<p class="empty">Aucun employé enregistré.</p>' : ''}
      </div>

      <div class="panel">
        <h2>Bulletins de paie</h2>
        <div class="panel-row" style="align-items:end">
          <label>Période<input type="month" id="mois-paie" value="${mois}" /></label>
          <button type="button" id="btn-generer-bulletins" ${employesSansBulletin.length === 0 ? 'disabled' : ''}>
            Générer les bulletins du mois (${employesSansBulletin.length})
          </button>
        </div>
        <table style="margin-top:16px">
          <thead><tr><th>Employé</th><th>Salaire brut</th><th>Charges sociales</th><th>Salaire net</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${
              bulletins.length
                ? bulletins
                    .map(
                      (b) => `<tr>
                        <td>${esc(b.nom_complet)}</td>
                        <td class="num">${fmt(b.salaire_brut)} FCFA</td>
                        <td class="num">${fmt(b.charges_sociales)} FCFA</td>
                        <td class="num">${fmt(b.salaire_net)} FCFA</td>
                        <td>${statutBulletinBadge(b.statut)}</td>
                        <td>${b.statut === 'EN_ATTENTE' ? `<button data-payer="${b.id}">Marquer payé</button>` : ''}</td>
                      </tr>`
                    )
                    .join('')
                : `<tr><td colspan="6" class="empty">Aucun bulletin pour ${mois}.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#form-employe').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/paie/employes', {
          nom_complet: fd.get('nom_complet'),
          poste: fd.get('poste'),
          secteur_id: fd.get('secteur_id') || null,
          telephone: fd.get('telephone'),
          date_embauche: fd.get('date_embauche') || null,
          salaire_brut_mensuel: fd.get('salaire_brut_mensuel') || null,
        });
        showToast('Employé ajouté.', 'success');
        window.Views.paie.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-modifier-employe]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const emp = employes.find((x) => x.id === Number(btn.dataset.modifierEmploye));
        const values = await Modal.open(`Modifier ${emp.nom_complet}`, [
          { name: 'nom_complet', label: 'Nom complet', type: 'text', value: emp.nom_complet },
          { name: 'poste', label: 'Poste', type: 'text', value: emp.poste || '' },
          { name: 'salaire_brut_mensuel', label: 'Salaire brut mensuel (FCFA)', type: 'number', value: emp.salaire_brut_mensuel || '' },
          {
            name: 'actif', label: 'Statut', type: 'select', value: String(emp.actif),
            options: [{ value: 'true', label: 'Actif' }, { value: 'false', label: 'Inactif (a quitté)' }],
          },
        ]);
        if (!values) return;
        try {
          await Api.put(`/paie/employes/${emp.id}`, {
            ...values,
            salaire_brut_mensuel: values.salaire_brut_mensuel !== '' ? Number(values.salaire_brut_mensuel) : null,
            actif: values.actif === 'true',
          });
          showToast('Employé mis à jour.', 'success');
          window.Views.paie.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer-employe]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const emp = employes.find((x) => x.id === Number(btn.dataset.supprimerEmploye));
        const values = await Modal.open(`Supprimer ${emp.nom_complet} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/paie/employes/${emp.id}`);
          showToast('Employé supprimé.', 'success');
          window.Views.paie.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelector('#mois-paie').addEventListener('change', (e) => {
      container.dataset.moisPaie = e.target.value;
      window.Views.paie.render(container);
    });

    const btnGenerer = container.querySelector('#btn-generer-bulletins');
    if (btnGenerer) {
      btnGenerer.addEventListener('click', async () => {
        for (const emp of employesSansBulletin) {
          const values = await Modal.open(`Bulletin de paie — ${emp.nom_complet} (${mois})`, [
            { name: 'salaire_brut', label: 'Salaire brut (FCFA)', type: 'number', value: emp.salaire_brut_mensuel || '' },
            { name: 'charges_sociales', label: 'Charges sociales (FCFA)', type: 'number', value: '0' },
          ]);
          if (!values || !values.salaire_brut) continue; // annulé ou vide : passe à l'employé suivant sans bloquer le lot
          try {
            await Api.post('/paie/bulletins', {
              employe_id: emp.id,
              periode: `${mois}-01`,
              salaire_brut: Number(values.salaire_brut),
              charges_sociales: Number(values.charges_sociales) || 0,
            });
          } catch (err) {
            showToast(`${emp.nom_complet} : ${err.message}`, 'error');
          }
        }
        showToast('Bulletins générés.', 'success');
        window.Views.paie.render(container);
      });
    }

    container.querySelectorAll('button[data-payer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.put(`/paie/bulletins/${btn.dataset.payer}/payer`, {});
          showToast('Bulletin marqué payé : dépense enregistrée.', 'success');
          window.Views.paie.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

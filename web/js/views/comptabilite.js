window.Views = window.Views || {};

const CATEGORIES_DEPENSE = ['Aliment', 'Intrants', "Main d'œuvre", 'Vétérinaire', 'Logistique', 'Autre'];

window.Views.comptabilite = {
  async render(container) {
    const [analytique, depenses, secteurs, releves, paiements] = await Promise.all([
      Api.get('/comptabilite/analytique'),
      Api.get('/comptabilite/depenses'),
      Api.get('/production/secteurs'),
      Api.get('/comptabilite/releves-bancaires'),
      Api.get('/finance/paiements'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Comptabilité analytique par pôle</h2>
        <p class="desc">Marge = chiffre d'affaires (commandes livrées ou en cours) − dépenses rattachées au pôle.</p>
        <table>
          <thead><tr><th>Pôle</th><th>Chiffre d'affaires</th><th>Dépenses</th><th>Marge</th></tr></thead>
          <tbody>
            ${analytique.parPole
              .map(
                (p) => `<tr>
                  <td>${esc(p.secteur_nom)}</td>
                  <td class="num">${fmt(p.chiffreAffaires)} FCFA</td>
                  <td class="num">${fmt(p.depenses)} FCFA</td>
                  <td class="num"><b class="${p.marge >= 0 ? 'text-success' : ''}" style="color:${p.marge >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(p.marge)} FCFA</b></td>
                </tr>`
              )
              .join('')}
            <tr>
              <td>Général (non rattaché)</td>
              <td class="num">-</td>
              <td class="num">${fmt(analytique.depensesGenerales)} FCFA</td>
              <td class="num">-</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Nouvelle dépense</h2>
        <form id="form-depense" class="form-grid">
          <label>Pôle (optionnel)
            <select name="secteur_id">
              <option value="">Général</option>
              ${secteurs.map((s) => `<option value="${s.id}">${s.nom}</option>`).join('')}
            </select>
          </label>
          <label>Catégorie
            <select name="categorie">${CATEGORIES_DEPENSE.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </label>
          <label>Montant (FCFA)<input type="number" name="montant" required /></label>
          <label>Date<input type="date" name="date_depense" required value="${new Date().toISOString().slice(0, 10)}" /></label>
          <label>Description<input type="text" name="description" /></label>
          <button type="submit">Enregistrer</button>
        </form>
        <table style="margin-top:16px">
          <thead><tr><th>Date</th><th>Pôle</th><th>Catégorie</th><th>Montant</th><th>Description</th><th></th></tr></thead>
          <tbody>
            ${
              depenses.length
                ? depenses
                    .map(
                      (d) => `<tr>
                        <td>${fmtDate(d.date_depense)}</td>
                        <td>${esc(d.secteur_nom) || 'Général'}</td>
                        <td>${esc(d.categorie)}</td>
                        <td class="num">${fmt(d.montant)} FCFA</td>
                        <td>${esc(d.description) || ''}</td>
                        <td><button class="secondary" data-del-depense="${d.id}">Supprimer</button></td>
                      </tr>`
                    )
                    .join('')
                : '<tr><td colspan="6" class="empty">Aucune dépense.</td></tr>'
            }
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Rapprochement bancaire</h2>
        <p class="desc">Saisie manuelle des opérations du relevé bancaire (simulateur d'import), à rapprocher des paiements enregistrés.</p>
        <form id="form-releve" class="form-grid">
          <label>Date<input type="date" name="date_operation" required value="${new Date().toISOString().slice(0, 10)}" /></label>
          <label>Libellé<input type="text" name="libelle" required placeholder="ex: VIR WAVE CLIENT X" /></label>
          <label>Montant (FCFA)<input type="number" name="montant" required /></label>
          <label>Type
            <select name="type_operation"><option value="CREDIT">Crédit (entrée)</option><option value="DEBIT">Débit (sortie)</option></select>
          </label>
          <button type="submit">Ajouter l'opération</button>
        </form>
        <table style="margin-top:16px">
          <thead><tr><th>Date</th><th>Libellé</th><th>Montant</th><th>Type</th><th>Statut</th><th></th></tr></thead>
          <tbody id="releves-body"></tbody>
        </table>
      </div>
    `;

    renderReleves(container, releves, paiements);

    container.querySelector('#form-depense').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/comptabilite/depenses', {
          secteur_id: fd.get('secteur_id') ? Number(fd.get('secteur_id')) : null,
          categorie: fd.get('categorie'),
          montant: Number(fd.get('montant')),
          description: fd.get('description') || null,
          date_depense: fd.get('date_depense'),
        });
        showToast('Dépense enregistrée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-del-depense]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.del(`/comptabilite/depenses/${btn.dataset.delDepense}`);
          showToast('Dépense supprimée.', 'success');
          window.Views.comptabilite.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelector('#form-releve').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/comptabilite/releves-bancaires', {
          date_operation: fd.get('date_operation'),
          libelle: fd.get('libelle'),
          montant: Number(fd.get('montant')),
          type_operation: fd.get('type_operation'),
        });
        showToast('Opération ajoutée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },
};

function renderReleves(container, releves, paiements) {
  const body = container.querySelector('#releves-body');
  const paiementsDejaRapproches = new Set(releves.filter((r) => r.paiement_id).map((r) => r.paiement_id));
  const paiementsDisponibles = paiements.filter((p) => p.statut === 'VALIDE' && !paiementsDejaRapproches.has(p.id));

  body.innerHTML = releves.length
    ? releves
        .map(
          (r) => `<tr>
            <td>${fmtDate(r.date_operation)}</td>
            <td>${esc(r.libelle)}</td>
            <td class="num">${fmt(r.montant)} FCFA</td>
            <td><span class="badge ${r.type_operation === 'CREDIT' ? 'ok' : 'muted'}">${esc(r.type_operation)}</span></td>
            <td>${
              r.rapproche
                ? `<span class="badge ok">Rapproché${r.client_nom ? ` — ${esc(r.client_nom)}` : ''}</span>`
                : `<span class="badge warn">En attente</span>`
            }</td>
            <td>
              ${
                r.rapproche
                  ? `<button class="secondary" data-annuler="${r.id}">Annuler</button>`
                  : `<select class="select-paiement" data-releve="${r.id}">
                      <option value="">— choisir un paiement —</option>
                      ${paiementsDisponibles.map((p) => `<option value="${p.id}" ${Number(p.montant) === Number(r.montant) ? 'selected' : ''}>${esc(p.client_nom)} — ${fmt(p.montant)} FCFA (${esc(p.methode_paiement)})</option>`).join('')}
                    </select>
                    <button class="secondary" data-rapprocher="${r.id}">Rapprocher</button>`
              }
            </td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Aucune opération.</td></tr>';

  body.querySelectorAll('button[data-rapprocher]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const select = body.querySelector(`.select-paiement[data-releve="${btn.dataset.rapprocher}"]`);
      if (!select.value) {
        showToast('Sélectionnez un paiement à rapprocher.', 'error');
        return;
      }
      try {
        await Api.put(`/comptabilite/releves-bancaires/${btn.dataset.rapprocher}/rapprocher`, { paiement_id: Number(select.value) });
        showToast('Opération rapprochée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('button[data-annuler]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await Api.put(`/comptabilite/releves-bancaires/${btn.dataset.annuler}/annuler-rapprochement`, {});
        showToast('Rapprochement annulé.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

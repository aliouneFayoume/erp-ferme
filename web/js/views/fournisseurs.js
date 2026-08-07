window.Views = window.Views || {};

window.Views.fournisseurs = {
  async render(container) {
    const [fournisseurs, commandes, alertes, produits] = await Promise.all([
      Api.get('/fournisseurs'),
      Api.get('/fournisseurs/commandes'),
      Api.get('/fournisseurs/reappro-alertes'),
      Api.get('/catalogue/produits'),
    ]);
    const moi = Api.getUser();

    container.innerHTML = `
      ${
        alertes.length
          ? `<div class="panel alert-panel">
              <h2>⚠ Alertes de réapprovisionnement</h2>
              <ul class="alert-list">
                ${alertes
                  .map((a) => `<li>${esc(a.produit_nom)} (${esc(a.secteur_nom)}) — ${fmt(a.quantite_disponible)} restant, seuil ${fmt(a.seuil_alerte)}</li>`)
                  .join('')}
              </ul>
            </div>`
          : ''
      }

      <div class="panel">
        <h2>Nouveau fournisseur</h2>
        <form id="form-fournisseur" class="form-grid">
          <label>Nom<input type="text" name="nom" required /></label>
          <label>Catégorie
            <select name="categorie">
              <option value="Aliment">Aliment</option>
              <option value="Intrants">Intrants</option>
              <option value="Vétérinaire">Vétérinaire</option>
              <option value="Matériel">Matériel</option>
              <option value="Autre">Autre</option>
            </select>
          </label>
          <label>Téléphone<input type="text" name="telephone" /></label>
          <label>Email<input type="email" name="email" /></label>
          <label>Adresse<input type="text" name="adresse" /></label>
          <button type="submit">Créer le fournisseur</button>
        </form>
      </div>

      <div class="panel">
        <h2>Fournisseurs (${fournisseurs.length}) — suivi des délais</h2>
        <table>
          <thead><tr><th>Nom</th><th>Catégorie</th><th>Contact</th><th>Livraisons reçues</th><th>Délai moyen</th><th>Taux de retard</th><th></th></tr></thead>
          <tbody>
            ${fournisseurs
              .map(
                (f) => `<tr>
                  <td>${esc(f.nom)}</td>
                  <td>${esc(f.categorie) || '-'}</td>
                  <td>${esc(f.telephone) || '-'}</td>
                  <td class="num">${f.nb_livraisons}</td>
                  <td class="num">${f.delai_moyen_jours != null ? `${f.delai_moyen_jours} j` : '-'}</td>
                  <td class="num">${f.taux_retard != null ? `<span class="badge ${f.taux_retard > 20 ? 'warn' : 'ok'}">${f.taux_retard}%</span>` : '-'}</td>
                  <td>${moi.role === 'admin' ? `<button class="danger" data-supprimer-fournisseur="${f.id}">Supprimer</button>` : ''}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${fournisseurs.length === 0 ? '<p class="empty">Aucun fournisseur enregistré.</p>' : ''}
      </div>

      <div class="panel">
        <h2>Nouvelle commande fournisseur</h2>
        <label>Fournisseur
          <select id="select-fournisseur">
            ${fournisseurs.map((f) => `<option value="${f.id}">${esc(f.nom)}</option>`).join('')}
          </select>
        </label>
        <label>Livraison prévue le<input type="date" id="date-livraison-prevue" /></label>
        <div class="lignes-builder" id="lignes-builder" style="margin-top:14px"></div>
        <button type="button" class="secondary" id="btn-add-ligne">+ Ajouter un produit</button>
        <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">
          <div>Total : <b id="total-estime">0 FCFA</b></div>
          <button type="button" id="btn-create-commande" ${fournisseurs.length === 0 ? 'disabled' : ''}>Créer la commande</button>
        </div>
      </div>

      <div class="panel">
        <h2>Commandes fournisseurs</h2>
        <table>
          <thead><tr><th>N°</th><th>Fournisseur</th><th>Montant</th><th>Livraison prévue</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${commandes
              .map(
                (c) => `<tr>
                  <td>${esc(c.numero_commande)}</td>
                  <td>${esc(c.fournisseur_nom)}</td>
                  <td class="num">${fmt(c.montant_total)} FCFA</td>
                  <td>${fmtDate(c.date_livraison_prevue)}</td>
                  <td>${statutCommandeFournisseurBadge(c.statut)}</td>
                  <td>${
                    c.statut === 'COMMANDEE'
                      ? `<button data-recevoir="${c.id}">Réceptionner</button> <button class="secondary" data-annuler="${c.id}">Annuler</button>`
                      : ''
                  }</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
        ${commandes.length === 0 ? '<p class="empty">Aucune commande fournisseur.</p>' : ''}
      </div>
    `;

    container.querySelector('#form-fournisseur').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/fournisseurs', {
          nom: fd.get('nom'),
          categorie: fd.get('categorie'),
          telephone: fd.get('telephone'),
          email: fd.get('email'),
          adresse: fd.get('adresse'),
        });
        showToast('Fournisseur créé.', 'success');
        window.Views.fournisseurs.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-supprimer-fournisseur]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const f = fournisseurs.find((x) => x.id === Number(btn.dataset.supprimerFournisseur));
        const values = await Modal.open(`Supprimer ${f.nom} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/fournisseurs/${btn.dataset.supprimerFournisseur}`);
          showToast('Fournisseur supprimé.', 'success');
          window.Views.fournisseurs.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // -------------------- Builder de commande fournisseur --------------------

    const builder = container.querySelector('#lignes-builder');
    const produitOptions = produits.map((p) => `<option value="${p.id}">${esc(p.nom)}</option>`).join('');

    function addLigneRow() {
      const row = el(`
        <div class="ligne-row">
          <select class="ligne-produit">${produitOptions}</select>
          <input type="number" class="ligne-qte" min="1" value="1" placeholder="Qté" />
          <input type="number" class="ligne-prix" min="0" step="0.01" placeholder="Prix unitaire" />
          <button type="button" class="secondary btn-remove-ligne">✕</button>
        </div>
      `);
      row.querySelector('.btn-remove-ligne').addEventListener('click', () => {
        row.remove();
        updateTotal();
      });
      row.querySelector('.ligne-qte').addEventListener('input', updateTotal);
      row.querySelector('.ligne-prix').addEventListener('input', updateTotal);
      builder.appendChild(row);
      updateTotal();
    }

    function updateTotal() {
      let total = 0;
      builder.querySelectorAll('.ligne-row').forEach((row) => {
        const qte = Number(row.querySelector('.ligne-qte').value || 0);
        const prix = Number(row.querySelector('.ligne-prix').value || 0);
        total += qte * prix;
      });
      container.querySelector('#total-estime').textContent = `${fmt(total)} FCFA`;
    }

    if (produits.length > 0) addLigneRow();
    container.querySelector('#btn-add-ligne').addEventListener('click', addLigneRow);

    container.querySelector('#btn-create-commande').addEventListener('click', async () => {
      const fournisseur_id = Number(container.querySelector('#select-fournisseur').value);
      const date_livraison_prevue = container.querySelector('#date-livraison-prevue').value || null;
      const lignes = [...builder.querySelectorAll('.ligne-row')].map((row) => ({
        produit_id: Number(row.querySelector('.ligne-produit').value),
        quantite: Number(row.querySelector('.ligne-qte').value),
        prix_unitaire: Number(row.querySelector('.ligne-prix').value),
      }));
      try {
        const commande = await Api.post('/fournisseurs/commandes', { fournisseur_id, date_livraison_prevue, lignes });
        showToast(`Commande ${commande.numero_commande} créée.`, 'success');
        window.Views.fournisseurs.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-recevoir]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.put(`/fournisseurs/commandes/${btn.dataset.recevoir}/recevoir`, {});
          showToast('Commande réceptionnée : stock crédité, dépense enregistrée.', 'success');
          window.Views.fournisseurs.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-annuler]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.put(`/fournisseurs/commandes/${btn.dataset.annuler}/annuler`, {});
          showToast('Commande annulée.', 'success');
          window.Views.fournisseurs.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

function statutCommandeFournisseurBadge(statut) {
  const map = { COMMANDEE: 'warn', RECUE: 'ok', ANNULEE: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut.replace('_', ' ')}</span>`;
}

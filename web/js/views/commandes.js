window.Views = window.Views || {};

window.Views.commandes = {
  async render(container) {
    const [commandes, clients, produits] = await Promise.all([
      Api.get('/commandes'),
      Api.get('/clients'),
      Api.get('/catalogue/produits'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvelle commande</h2>
        <p class="desc">La grille tarifaire à 3 niveaux (standard / restaurant / grossiste) est appliquée automatiquement selon le client. Le stock est réservé dans le bon pool. Un encours B2B au-delà de la limite de crédit bloque la commande.</p>
        <label>Client
          <select id="select-client">
            ${clients
              .map(
                (c) =>
                  `<option value="${c.id}" data-type="${c.type_client}" data-categorie="${c.categorie_tarifaire}">${esc(c.nom)} (${esc(c.categorie_tarifaire)}${c.type_client === 'B2B' ? ` · encours ${fmt(c.solde_encours)}/${fmt(c.limite_credit)}` : ''})</option>`
              )
              .join('')}
          </select>
        </label>
        <div class="lignes-builder" id="lignes-builder" style="margin-top:14px"></div>
        <button type="button" class="secondary" id="btn-add-ligne">+ Ajouter un produit</button>
        <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">
          <div>Total estimé : <b id="total-estime">0 FCFA</b></div>
          <button type="button" id="btn-create-commande">Créer la commande</button>
        </div>
      </div>

      <div class="panel">
        <h2>Commandes récentes</h2>
        <table>
          <thead><tr><th>N°</th><th>Client</th><th>Type</th><th>Montant</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${commandes
              .map(
                (c) => `<tr>
                  <td>${esc(c.numero_commande)}</td>
                  <td>${esc(c.client_nom)}</td>
                  <td><span class="badge ${c.type_client === 'B2B' ? 'muted' : 'ok'}">${c.type_client}</span></td>
                  <td class="num">${fmt(c.montant_total)} FCFA</td>
                  <td>${statutBadge(c.statut)}</td>
                  <td>${statutActions(c)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    const builder = container.querySelector('#lignes-builder');
    const produitOptions = produits
      .map(
        (p) =>
          `<option value="${p.id}" data-b2b="${p.prix_unitaire_b2b}" data-b2c="${p.prix_unitaire_b2c}" data-gros="${p.prix_unitaire_grossiste ?? ''}">${esc(p.nom)} (dispo: ${fmt(p.quantite_disponible)})</option>`
      )
      .join('');

    function addLigneRow() {
      const row = el(`
        <div class="ligne-row">
          <select class="ligne-produit">${produitOptions}</select>
          <input type="number" class="ligne-qte" min="1" value="1" />
          <button type="button" class="secondary btn-remove-ligne">✕</button>
        </div>
      `);
      row.querySelector('.btn-remove-ligne').addEventListener('click', () => {
        row.remove();
        updateTotal();
      });
      row.querySelector('.ligne-qte').addEventListener('input', updateTotal);
      row.querySelector('.ligne-produit').addEventListener('change', updateTotal);
      builder.appendChild(row);
      updateTotal();
    }

    function currentClient() {
      const opt = container.querySelector('#select-client').selectedOptions[0];
      return opt ? { type: opt.dataset.type, categorie: opt.dataset.categorie } : { type: 'B2C', categorie: 'standard' };
    }

    // Miroir de resolvePrixUnitaire() côté serveur (server/src/routes/commandes.js) : grossiste
    // n'est appliqué que si un tarif grossiste existe pour le produit, sinon retombe sur B2B.
    function prixPourClient(opt, client) {
      if (client.categorie === 'grossiste' && opt.dataset.gros) return Number(opt.dataset.gros);
      return Number(client.type === 'B2B' ? opt.dataset.b2b : opt.dataset.b2c);
    }

    function updateTotal() {
      const client = currentClient();
      let total = 0;
      builder.querySelectorAll('.ligne-row').forEach((row) => {
        const opt = row.querySelector('.ligne-produit').selectedOptions[0];
        const qte = Number(row.querySelector('.ligne-qte').value || 0);
        total += prixPourClient(opt, client) * qte;
      });
      container.querySelector('#total-estime').textContent = `${fmt(total)} FCFA`;
    }

    container.querySelector('#select-client').addEventListener('change', updateTotal);
    container.querySelector('#btn-add-ligne').addEventListener('click', addLigneRow);
    addLigneRow();

    container.querySelector('#btn-create-commande').addEventListener('click', async () => {
      const client_id = Number(container.querySelector('#select-client').value);
      const lignes = [...builder.querySelectorAll('.ligne-row')].map((row) => ({
        produit_id: Number(row.querySelector('.ligne-produit').value),
        quantite: Number(row.querySelector('.ligne-qte').value),
      }));
      try {
        const commande = await Api.post('/commandes', { client_id, lignes });
        showToast(`Commande ${commande.numero_commande} créée.`, 'success');
        window.Views.commandes.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-set-statut]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.put(`/commandes/${btn.dataset.id}/statut`, { statut: btn.dataset.setStatut });
          showToast('Statut mis à jour.', 'success');
          window.Views.commandes.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

function statutBadge(statut) {
  const map = {
    EN_ATTENTE: 'warn',
    PREPAREE: 'info',
    EN_LIVRAISON: 'info',
    LIVREE: 'ok',
    ANNULEE: 'danger',
  };
  return `<span class="badge ${map[statut] || 'muted'}">${statut.replace('_', ' ')}</span>`;
}

function statutActions(c) {
  const next = { EN_ATTENTE: 'PREPAREE', PREPAREE: 'EN_LIVRAISON', EN_LIVRAISON: 'LIVREE' }[c.statut];
  if (!next) return '';
  return `<button class="secondary" data-set-statut="${next}" data-id="${c.id}">→ ${next.replace('_', ' ')}</button>`;
}

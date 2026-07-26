window.Views = window.Views || {};

window.Views.finance = {
  async render(container) {
    const [factures, paiements, clients, commandes] = await Promise.all([
      Api.get('/finance/factures'),
      Api.get('/finance/paiements'),
      Api.get('/clients'),
      Api.get('/commandes'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Initier un paiement Mobile Money</h2>
        <p class="desc">Simule le Push USSD Wave / Orange Money. Le paiement reste "EN_ATTENTE" jusqu'à réception du webhook de confirmation (ci-dessous).</p>
        <form id="form-paiement" class="form-grid">
          <label>Commande
            <select name="commande_id" required>
              ${commandes.filter((c) => c.statut !== 'ANNULEE').map((c) => `<option value="${c.id}" data-client="${c.client_id}">${esc(c.numero_commande)} — ${esc(c.client_nom)} (${fmt(c.montant_total)} FCFA)</option>`).join('')}
            </select>
          </label>
          <label>Montant<input type="number" name="montant" required /></label>
          <label>Provider
            <select name="provider"><option value="WAVE">Wave</option><option value="ORANGE_MONEY">Orange Money</option></select>
          </label>
          <button type="submit">Initier le paiement</button>
        </form>
      </div>

      <div class="panel" id="paiements-panel">
        <h2>Paiements</h2>
        <table>
          <thead><tr><th>Référence</th><th>Client</th><th>Montant</th><th>Méthode</th><th>Statut</th><th></th></tr></thead>
          <tbody id="paiements-body"></tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Factures</h2>
        <table>
          <thead><tr><th>Commande</th><th>Client</th><th>Type</th><th>Échéance</th><th>Restant dû</th><th>Statut</th></tr></thead>
          <tbody>
            ${factures
              .map(
                (f) => `<tr>
                  <td>${esc(f.numero_commande)}</td>
                  <td>${esc(f.client_nom)}</td>
                  <td><span class="badge ${f.type_client === 'B2B' ? 'muted' : 'ok'}">${esc(f.type_client)}</span></td>
                  <td>${fmtDate(f.date_echeance)}</td>
                  <td class="num">${fmt(f.montant_restant)} FCFA</td>
                  <td>${factureBadge(f.statut)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    renderPaiements(container, paiements);

    container.querySelector('#form-paiement').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const commandeId = fd.get('commande_id');
      const clientId = e.target.querySelector(`option[value="${commandeId}"]`).dataset.client;
      try {
        await Api.post('/finance/paiements/initier', {
          commande_id: Number(commandeId),
          client_id: Number(clientId),
          montant: Number(fd.get('montant')),
          provider: fd.get('provider'),
        });
        showToast('Paiement initié (en attente du webhook provider).', 'success');
        window.Views.finance.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },
};

function renderPaiements(container, paiements) {
  const body = container.querySelector('#paiements-body');
  body.innerHTML = paiements.length
    ? paiements
        .map(
          (p) => `<tr>
            <td>${esc(p.reference_transaction) || '-'}</td>
            <td>${esc(p.client_nom)}</td>
            <td class="num">${fmt(p.montant)} FCFA</td>
            <td>${esc(p.methode_paiement)}</td>
            <td>${paiementBadge(p.statut)}</td>
            <td>${p.statut === 'EN_ATTENTE' ? `<button class="secondary" data-simulate="${esc(p.reference_transaction)}" data-montant="${p.montant}" data-provider="${esc(p.methode_paiement)}">Simuler webhook succès</button>` : ''}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Aucun paiement.</td></tr>';

  body.querySelectorAll('button[data-simulate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await Api.post('/finance/paiements/webhook', {
          reference_transaction: btn.dataset.simulate,
          statut_paiement: 'SUCCESS',
          montant: Number(btn.dataset.montant),
          provider: btn.dataset.provider,
        });
        showToast('Webhook traité : paiement validé, facture mise à jour.', 'success');
        window.Views.finance.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function factureBadge(statut) {
  const map = { A_PAYER: 'warn', PAYEE_PARTIEL: 'info', PAYEE: 'ok', EN_RETARD: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut.replace('_', ' ')}</span>`;
}
function paiementBadge(statut) {
  const map = { EN_ATTENTE: 'warn', VALIDE: 'ok', ECHOUE: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut}</span>`;
}

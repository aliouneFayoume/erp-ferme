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
        <p class="desc">Crée une facture PayDunya réelle (Wave / Orange Money / carte). Le paiement reste "EN_ATTENTE" jusqu'à confirmation automatique par PayDunya.</p>
        <form id="form-paiement" class="form-grid" autocomplete="off">
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

      <div class="panel hidden" id="checkout-link-panel"></div>

      <div class="panel" id="paiements-panel">
        <h2>Paiements</h2>
        <table>
          <thead><tr><th>Référence</th><th>Client</th><th>Montant</th><th>Méthode</th><th>Statut</th></tr></thead>
          <tbody id="paiements-body"></tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Factures</h2>
        ${facturesEnRetardBanner(factures)}
        <table>
          <thead><tr><th>Commande</th><th>Client</th><th>Type</th><th>Échéance</th><th>Restant dû</th><th>Statut</th><th></th></tr></thead>
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
                  <td style="white-space:nowrap">
                    <button class="secondary" data-facture-pdf="${f.id}" data-numero="${esc(f.numero_commande)}">PDF</button>
                    ${Number(f.montant_restant) > 0 ? `<button class="secondary" data-rappel-whatsapp="${f.id}">Rappel WhatsApp</button>` : ''}
                  </td>
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
        const paiement = await Api.post('/finance/paiements/initier', {
          commande_id: Number(commandeId),
          client_id: Number(clientId),
          montant: Number(fd.get('montant')),
          provider: fd.get('provider'),
        });
        showToast('Paiement initié — transmettez le lien de paiement au client.', 'success');
        // render() remplace tout le contenu du conteneur : on affiche le lien de paiement APRÈS,
        // sur le panneau fraîchement recréé, sinon il serait immédiatement écrasé.
        await window.Views.finance.render(container);
        afficherLienCheckout(container, paiement.checkout_url);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-facture-pdf]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const blob = await Api.getBlob(`/finance/factures/${btn.dataset.facturePdf}/pdf`);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `facture-${btn.dataset.numero}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-rappel-whatsapp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const texteOriginal = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Envoi…';
        try {
          await Api.post(`/finance/factures/${btn.dataset.rappelWhatsapp}/rappel-whatsapp`, {});
          showToast('Rappel WhatsApp envoyé.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = texteOriginal;
        }
      });
    });
  },
};

/**
 * Le paiement se fait sur la page hébergée PayDunya, pas dans l'ERP : le lien est affiché pour
 * que le comptable/admin le transmette au client (SMS/WhatsApp) plutôt que de rediriger son propre
 * onglet hors de l'ERP.
 */
function afficherLienCheckout(container, url) {
  const panel = container.querySelector('#checkout-link-panel');
  if (!panel || !url) return;
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <h2>Lien de paiement</h2>
    <p class="desc">Envoyez ce lien au client pour qu'il complète le paiement (Wave, Orange Money ou carte).</p>
    <div class="panel-row">
      <input type="text" readonly value="${esc(url)}" style="flex:1" onclick="this.select()" />
      <button id="btn-copier-lien" class="secondary">Copier</button>
    </div>
  `;
  panel.querySelector('#btn-copier-lien').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien copié.', 'success');
    } catch (err) {
      showToast("Impossible de copier automatiquement — sélectionnez et copiez le lien manuellement.", 'error');
    }
  });
}

function facturesEnRetardBanner(factures) {
  const enRetard = factures.filter((f) => f.statut === 'EN_RETARD');
  if (enRetard.length === 0) return '';
  const total = enRetard.reduce((s, f) => s + Number(f.montant_restant), 0);
  return `<div class="offline-banner"><span>${enRetard.length} facture(s) en retard, ${fmt(total)} FCFA au total</span></div>`;
}

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
          </tr>`
        )
        .join('')
    : '<tr><td colspan="5" class="empty">Aucun paiement.</td></tr>';
}

function factureBadge(statut) {
  const map = { A_PAYER: 'warn', PAYEE_PARTIEL: 'info', PAYEE: 'ok', EN_RETARD: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut.replace('_', ' ')}</span>`;
}
function paiementBadge(statut) {
  const map = { EN_ATTENTE: 'warn', VALIDE: 'ok', ECHOUE: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut}</span>`;
}

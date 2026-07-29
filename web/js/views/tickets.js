window.Views = window.Views || {};

const TICKET_STATUT_LABELS = { OUVERT: 'Ouvert', EN_COURS: 'En cours', RESOLU: 'Résolu', FERME: 'Fermé' };
const TICKET_STATUT_BADGE = { OUVERT: 'warn', EN_COURS: 'info', RESOLU: 'ok', FERME: 'muted' };
const TICKET_PRIORITE_BADGE = { URGENTE: 'danger', HAUTE: 'warn', NORMALE: 'info', BASSE: 'muted' };

window.Views.tickets = {
  async render(container) {
    const [tickets, clients] = await Promise.all([Api.get('/tickets'), Api.get('/clients')]);

    container.innerHTML = `
      <div class="panel">
        <h2>Nouveau ticket</h2>
        <form id="form-ticket" class="form-grid">
          <label>Client
            <select name="client_id" required>
              <option value="">— Choisir —</option>
              ${clients.map((c) => `<option value="${c.id}">${esc(c.nom)} (${esc(c.telephone)})</option>`).join('')}
            </select>
          </label>
          <label>Sujet<input type="text" name="sujet" required /></label>
          <label>Priorité
            <select name="priorite">
              <option value="BASSE">Basse</option>
              <option value="NORMALE" selected>Normale</option>
              <option value="HAUTE">Haute</option>
              <option value="URGENTE">Urgente</option>
            </select>
          </label>
          <label class="span-2">Description<textarea name="description" rows="2"></textarea></label>
          <button type="submit">Créer le ticket</button>
        </form>
      </div>

      <div class="panel">
        <h2>Tickets (${tickets.length})</h2>
        <div class="form-grid" style="margin-bottom: 1rem;">
          <label>Filtrer par statut
            <select id="filtre-statut">
              <option value="">Tous</option>
              ${Object.entries(TICKET_STATUT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
            </select>
          </label>
        </div>
        <table>
          <thead><tr><th>Client</th><th>Sujet</th><th>Priorité</th><th>Statut</th><th>Assigné à</th><th>Créé le</th><th></th></tr></thead>
          <tbody>
            ${tickets
              .map(
                (t) => `<tr>
                  <td>${esc(t.client_nom)}<br><span class="desc">${esc(t.client_telephone)}</span></td>
                  <td>${esc(t.sujet)}</td>
                  <td><span class="badge ${TICKET_PRIORITE_BADGE[t.priorite] || 'muted'}">${esc(t.priorite)}</span></td>
                  <td><span class="badge ${TICKET_STATUT_BADGE[t.statut] || 'muted'}">${esc(TICKET_STATUT_LABELS[t.statut] || t.statut)}</span></td>
                  <td>${esc(t.assigne_nom) || '-'}</td>
                  <td>${fmtDate(t.cree_le)}</td>
                  <td><button class="secondary" data-ouvrir="${t.id}">Ouvrir</button></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#form-ticket').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/tickets', {
          client_id: Number(fd.get('client_id')),
          sujet: fd.get('sujet'),
          priorite: fd.get('priorite'),
          description: fd.get('description'),
        });
        showToast('Ticket créé.', 'success');
        window.Views.tickets.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#filtre-statut').addEventListener('change', async (e) => {
      const statut = e.target.value;
      const filtres = await Api.get(statut ? `/tickets?statut=${statut}` : '/tickets');
      const tbody = container.querySelector('table tbody');
      tbody.innerHTML = filtres
        .map(
          (t) => `<tr>
            <td>${esc(t.client_nom)}<br><span class="desc">${esc(t.client_telephone)}</span></td>
            <td>${esc(t.sujet)}</td>
            <td><span class="badge ${TICKET_PRIORITE_BADGE[t.priorite] || 'muted'}">${esc(t.priorite)}</span></td>
            <td><span class="badge ${TICKET_STATUT_BADGE[t.statut] || 'muted'}">${esc(TICKET_STATUT_LABELS[t.statut] || t.statut)}</span></td>
            <td>${esc(t.assigne_nom) || '-'}</td>
            <td>${fmtDate(t.cree_le)}</td>
            <td><button class="secondary" data-ouvrir="${t.id}">Ouvrir</button></td>
          </tr>`
        )
        .join('');
      attachOuvrirHandlers(tbody, container, filtres);
    });

    attachOuvrirHandlers(container.querySelector('table tbody'), container, tickets);
  },
};

function attachOuvrirHandlers(scope, container, tickets) {
  scope.querySelectorAll('button[data-ouvrir]').forEach((btn) => {
    btn.addEventListener('click', () => ouvrirTicket(container, tickets.find((t) => t.id === Number(btn.dataset.ouvrir))));
  });
}

async function ouvrirTicket(container, ticket) {
  const messages = await Api.get(`/tickets/${ticket.id}/messages`);

  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>${esc(ticket.sujet)}</h3>
        <p class="desc">${esc(ticket.client_nom)} — ${esc(ticket.client_telephone)}</p>
        <div class="form-grid">
          <label>Statut
            <select data-champ="statut">
              ${Object.entries(TICKET_STATUT_LABELS)
                .map(([k, v]) => `<option value="${k}" ${k === ticket.statut ? 'selected' : ''}>${v}</option>`)
                .join('')}
            </select>
          </label>
          <label>Priorité
            <select data-champ="priorite">
              ${['BASSE', 'NORMALE', 'HAUTE', 'URGENTE']
                .map((p) => `<option value="${p}" ${p === ticket.priorite ? 'selected' : ''}>${p}</option>`)
                .join('')}
            </select>
          </label>
        </div>
        <div class="ticket-thread" style="max-height: 240px; overflow-y: auto; margin: 1rem 0;">
          ${
            messages.length
              ? messages
                  .map((m) => `<p><strong>${esc(m.auteur_nom)}</strong> <span class="desc">(${fmtDate(m.cree_le)})</span><br>${esc(m.message)}</p>`)
                  .join('')
              : '<p class="empty">Aucun échange pour l\'instant.</p>'
          }
        </div>
        <form id="form-message" class="form-grid">
          <label class="span-2">Ajouter un message<textarea name="message" rows="2" required></textarea></label>
        </form>
        <div class="modal-actions">
          <button class="secondary" data-action="fermer">Fermer</button>
          <button data-action="envoyer">Envoyer</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);

  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('[data-action="fermer"]').addEventListener('click', closeModal);

  overlay.querySelectorAll('select[data-champ]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await Api.put(`/tickets/${ticket.id}`, { [sel.dataset.champ]: sel.value });
        showToast('Ticket mis à jour.', 'success');
        closeModal();
        window.Views.tickets.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  overlay.querySelector('[data-action="envoyer"]').addEventListener('click', async () => {
    const message = overlay.querySelector('textarea[name="message"]').value.trim();
    if (!message) return;
    try {
      await Api.post(`/tickets/${ticket.id}/messages`, { message });
      closeModal();
      window.Views.tickets.render(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

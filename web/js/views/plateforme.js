window.Views = window.Views || {};

const PLATEFORME_STATUT_LABELS = { OUVERT: 'Ouvert', EN_COURS: 'En cours', RESOLU: 'Résolu', FERME: 'Fermé' };
const PLATEFORME_STATUT_BADGE = { OUVERT: 'warn', EN_COURS: 'info', RESOLU: 'ok', FERME: 'muted' };
const PLATEFORME_PRIORITE_BADGE = { URGENTE: 'danger', HAUTE: 'warn', NORMALE: 'info', BASSE: 'muted' };

window.Views.plateforme = {
  async render(container) {
    const [organisations, tickets] = await Promise.all([Api.get('/plateforme/organisations'), Api.get('/plateforme/tickets')]);

    container.innerHTML = `
      <div class="panel">
        <h2>Fermes (${organisations.length})</h2>
        <p class="desc">Vue lecture seule sur toutes les organisations — pour répondre à un ticket, connectez-vous en tant qu'administrateur de la ferme concernée.</p>
        <table>
          <thead><tr><th>Ferme</th><th>Créée le</th><th>Utilisateurs actifs</th><th>Tickets ouverts</th><th>Tickets (total)</th><th></th></tr></thead>
          <tbody>
            ${organisations
              .map(
                (o) => `<tr>
                  <td>${esc(o.nom)}</td>
                  <td>${fmtDate(o.cree_le)}</td>
                  <td>${o.utilisateurs_actifs}</td>
                  <td>${o.tickets_ouverts > 0 ? `<span class="badge warn">${o.tickets_ouverts}</span>` : '0'}</td>
                  <td>${o.tickets_total}</td>
                  <td><button class="secondary" data-connecter="${o.id}">Se connecter en tant qu'administrateur</button></td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Tickets — toutes fermes (${tickets.length})</h2>
        <div class="form-grid" style="margin-bottom: 1rem;">
          <label>Filtrer par statut
            <select id="filtre-statut-plateforme">
              <option value="">Tous</option>
              ${Object.entries(PLATEFORME_STATUT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
            </select>
          </label>
        </div>
        <table>
          <thead><tr><th>Ferme</th><th>Client</th><th>Sujet</th><th>Priorité</th><th>Statut</th><th>Créé le</th><th></th></tr></thead>
          <tbody id="plateforme-tickets-body">
            ${renderLignesTickets(tickets)}
          </tbody>
        </table>
      </div>
    `;

    container.querySelectorAll('button[data-connecter]').forEach((btn) => {
      btn.addEventListener('click', () => seConnecterAdmin(btn.dataset.connecter));
    });

    container.querySelector('#filtre-statut-plateforme').addEventListener('change', async (e) => {
      const statut = e.target.value;
      const filtres = await Api.get(statut ? `/plateforme/tickets?statut=${statut}` : '/plateforme/tickets');
      const tbody = container.querySelector('#plateforme-tickets-body');
      tbody.innerHTML = renderLignesTickets(filtres);
      attacherOuvrirTicket(tbody, filtres);
    });

    attacherOuvrirTicket(container.querySelector('#plateforme-tickets-body'), tickets);
  },
};

function renderLignesTickets(tickets) {
  if (tickets.length === 0) return '<tr><td colspan="7" class="empty">Aucun ticket.</td></tr>';
  return tickets
    .map(
      (t) => `<tr>
        <td>${esc(t.organisation_nom)}</td>
        <td>${esc(t.client_nom) || '-'}</td>
        <td>${esc(t.sujet)}</td>
        <td><span class="badge ${PLATEFORME_PRIORITE_BADGE[t.priorite] || 'muted'}">${esc(t.priorite)}</span></td>
        <td><span class="badge ${PLATEFORME_STATUT_BADGE[t.statut] || 'muted'}">${esc(PLATEFORME_STATUT_LABELS[t.statut] || t.statut)}</span></td>
        <td>${fmtDate(t.cree_le)}</td>
        <td><button class="secondary" data-voir="${t.id}">Voir les échanges</button></td>
      </tr>`
    )
    .join('');
}

function attacherOuvrirTicket(scope, tickets) {
  scope.querySelectorAll('button[data-voir]').forEach((btn) => {
    btn.addEventListener('click', () => voirEchangesTicket(tickets.find((t) => t.id === Number(btn.dataset.voir))));
  });
}

async function voirEchangesTicket(ticket) {
  const messages = await Api.get(`/plateforme/tickets/${ticket.id}/messages`);

  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>${esc(ticket.sujet)}</h3>
        <p class="desc">${esc(ticket.organisation_nom)} — ${esc(ticket.client_nom) || 'client inconnu'}</p>
        <div class="ticket-thread" style="max-height: 300px; overflow-y: auto; margin: 1rem 0;">
          ${
            messages.length
              ? messages
                  .map((m) => `<p><strong>${esc(m.auteur_nom)}</strong> <span class="desc">(${fmtDate(m.cree_le)})</span><br>${esc(m.message)}</p>`)
                  .join('')
              : '<p class="empty">Aucun échange pour l\'instant.</p>'
          }
        </div>
        <p class="desc">Lecture seule — connectez-vous en tant qu'administrateur de cette ferme pour répondre.</p>
        <div class="modal-actions">
          <button class="secondary" data-action="fermer">Fermer</button>
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
}

async function seConnecterAdmin(tenantId) {
  try {
    const { token, utilisateur } = await Api.post(`/plateforme/organisations/${tenantId}/se-connecter-admin`, {});
    Api.setSession(token, utilisateur);
    window.location.href = '/';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

window.Views = window.Views || {};

const PLATEFORME_STATUT_LABELS = { OUVERT: 'Ouvert', EN_COURS: 'En cours', RESOLU: 'Résolu', FERME: 'Fermé' };
const PLATEFORME_STATUT_BADGE = { OUVERT: 'warn', EN_COURS: 'info', RESOLU: 'ok', FERME: 'muted' };
const PLATEFORME_PRIORITE_BADGE = { URGENTE: 'danger', HAUTE: 'warn', NORMALE: 'info', BASSE: 'muted' };

const FACTURE_SAAS_STATUT_LABELS = { A_PAYER: 'À payer', PAYEE: 'Payée', EN_RETARD: 'En retard', ANNULEE: 'Annulée' };
const FACTURE_SAAS_STATUT_BADGE = { A_PAYER: 'warn', PAYEE: 'ok', EN_RETARD: 'danger', ANNULEE: 'muted' };

window.Views.plateforme = {
  async render(container) {
    const [organisations, tickets, catalogue, facturesSaas] = await Promise.all([
      Api.get('/plateforme/organisations'),
      Api.get('/plateforme/tickets'),
      Api.get('/plateforme/modules-saas'),
      Api.get('/plateforme/factures-saas'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Fermes (${organisations.length})</h2>
        <p class="desc">Vue lecture seule sur toutes les organisations — pour répondre à un ticket, connectez-vous en tant qu'administrateur de la ferme concernée.</p>
        <button id="btn-creer-ferme" style="margin-bottom: 1rem;">Créer une nouvelle ferme</button>
        <table>
          <thead><tr><th>Ferme</th><th>Sous-domaine</th><th>Créée le</th><th>Utilisateurs actifs</th><th>Tickets ouverts</th><th>Tickets (total)</th><th></th></tr></thead>
          <tbody>
            ${organisations
              .map(
                (o) => `<tr>
                  <td>${esc(o.nom)}</td>
                  <td>
                    ${o.slug ? `<code>${esc(o.slug)}.massla.sn</code>` : '<span class="desc">—</span>'}
                    <button class="secondary" data-modifier-slug="${o.id}" data-slug="${esc(o.slug || '')}" style="margin-left:6px;">Modifier</button>
                  </td>
                  <td>${fmtDate(o.cree_le)}</td>
                  <td>${o.utilisateurs_actifs}</td>
                  <td>${o.tickets_ouverts > 0 ? `<span class="badge warn">${o.tickets_ouverts}</span>` : '0'}</td>
                  <td>${o.tickets_total}</td>
                  <td style="white-space:nowrap">
                    <button class="secondary" data-abonnement="${o.id}">Abonnement SaaS</button>
                    <button class="secondary" data-connecter="${o.id}">Se connecter en tant qu'administrateur</button>
                    <button class="danger" data-supprimer="${o.id}" data-nom="${esc(o.nom)}">Supprimer</button>
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Facturation SaaS</h2>
        <p class="desc">Collecte manuelle : le paiement de chaque ferme se fait par le moyen de votre choix (Wave, virement, espèces) — marquez la facture comme payée une fois reçue.</p>
        <button id="btn-generer-factures-saas" style="margin-bottom: 1rem;">Générer les factures du mois</button>
        <table>
          <thead><tr><th>Ferme</th><th>Type</th><th>Période</th><th>Montant</th><th>Échéance</th><th>Statut</th><th></th></tr></thead>
          <tbody id="factures-saas-body">
            ${renderLignesFacturesSaas(facturesSaas)}
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

    container.querySelector('#btn-creer-ferme').addEventListener('click', () => ouvrirCreationFerme(container));
    container.querySelectorAll('button[data-connecter]').forEach((btn) => {
      btn.addEventListener('click', () => seConnecterAdmin(btn.dataset.connecter));
    });
    container.querySelectorAll('button[data-abonnement]').forEach((btn) => {
      const org = organisations.find((o) => o.id === Number(btn.dataset.abonnement));
      btn.addEventListener('click', () => ouvrirAbonnementSaas(container, org, catalogue));
    });
    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', () => supprimerFerme(container, btn.dataset.supprimer, btn.dataset.nom));
    });
    container.querySelectorAll('button[data-modifier-slug]').forEach((btn) => {
      btn.addEventListener('click', () => modifierSlug(container, btn.dataset.modifierSlug, btn.dataset.slug));
    });

    container.querySelector('#filtre-statut-plateforme').addEventListener('change', async (e) => {
      const statut = e.target.value;
      const filtres = await Api.get(statut ? `/plateforme/tickets?statut=${statut}` : '/plateforme/tickets');
      const tbody = container.querySelector('#plateforme-tickets-body');
      tbody.innerHTML = renderLignesTickets(filtres);
      attacherOuvrirTicket(tbody, filtres);
    });

    container.querySelector('#btn-generer-factures-saas').addEventListener('click', async () => {
      try {
        const resultat = await Api.post('/plateforme/factures-saas/generer', {});
        showToast(`${resultat.creees} facture(s) générée(s) pour ${resultat.periode} (${resultat.deja_generees} déjà existante(s)).`, 'success');
        window.Views.plateforme.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    attacherOuvrirTicket(container.querySelector('#plateforme-tickets-body'), tickets);
    attacherActionsFactures(container.querySelector('#factures-saas-body'), facturesSaas, container);
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

function ouvrirCreationFerme(container) {
  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Créer une nouvelle ferme</h3>
        <p class="desc">Même création que l'inscription self-service, sans code d'invitation — pratique pour configurer un client vous-même.</p>
        <form id="form-creation-ferme" class="form-grid">
          <label>Nom de la ferme<input type="text" name="nomFerme" required autocomplete="off" /></label>

          <div>
            <p class="sub" style="margin:0 0 8px;">Secteur(s) d'activité (au moins un)</p>
            <label style="flex-direction: row; align-items: center; gap: 8px;">
              <input type="checkbox" name="secteur-avicole" style="width:auto" /> Avicole
            </label>
            <label style="flex-direction: row; align-items: center; gap: 8px;">
              <input type="checkbox" name="secteur-piscicole" style="width:auto" /> Piscicole
            </label>
            <label style="flex-direction: row; align-items: center; gap: 8px;">
              <input type="checkbox" name="secteur-maraicher" style="width:auto" /> Maraîcher
            </label>
            <label>Autre secteur (optionnel)<input type="text" name="secteurAutreNom" autocomplete="off" placeholder="ex: Élevage bovin" /></label>
            <label style="flex-direction: row; align-items: center; gap: 8px;">
              <input type="checkbox" name="secteurAutreRecolte" style="width:auto" /> Suivre une date de récolte prévue pour ce secteur
            </label>
          </div>

          <label>Nom complet de l'administrateur<input type="text" name="adminNomComplet" required autocomplete="off" /></label>
          <label>Email<input type="email" name="adminEmail" required autocomplete="off" /></label>
          <label>Mot de passe (8 caractères minimum)<input type="password" name="adminPassword" required minlength="8" autocomplete="new-password" /></label>
        </form>
        <div class="modal-actions">
          <button class="secondary" data-action="annuler">Annuler</button>
          <button data-action="creer">Créer la ferme</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);
  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('[data-action="annuler"]').addEventListener('click', closeModal);

  overlay.querySelector('[data-action="creer"]').addEventListener('click', async () => {
    const fd = new FormData(overlay.querySelector('#form-creation-ferme'));
    const secteurs = [];
    if (fd.get('secteur-avicole')) secteurs.push({ nom: 'Avicole', suiviRecolte: false });
    if (fd.get('secteur-piscicole')) secteurs.push({ nom: 'Piscicole', suiviRecolte: false });
    if (fd.get('secteur-maraicher')) secteurs.push({ nom: 'Maraîcher', suiviRecolte: true });
    const autreNom = (fd.get('secteurAutreNom') || '').trim();
    if (autreNom) secteurs.push({ nom: autreNom, suiviRecolte: !!fd.get('secteurAutreRecolte') });
    if (secteurs.length === 0) {
      showToast("Sélectionnez au moins un secteur d'activité.", 'error');
      return;
    }
    try {
      await Api.post('/plateforme/organisations', {
        nomFerme: fd.get('nomFerme'),
        secteurs,
        adminNomComplet: fd.get('adminNomComplet'),
        adminEmail: fd.get('adminEmail'),
        adminPassword: fd.get('adminPassword'),
      });
      showToast('Ferme créée.', 'success');
      closeModal();
      window.Views.plateforme.render(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function seConnecterAdmin(tenantId) {
  try {
    const { token, utilisateur } = await Api.post(`/plateforme/organisations/${tenantId}/se-connecter-admin`, {});
    // Met de côté la session superviseur en cours pour pouvoir y revenir (bouton "Retour à la
    // supervision" dans le topbar, voir app.js) sans avoir à se reconnecter.
    Api.setSuperviseurSession(Api.getToken(), Api.getUser());
    Api.setSession(token, utilisateur);
    window.location.href = '/';
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function supprimerFerme(container, tenantId, nom) {
  const values = await Modal.open(`Supprimer ${esc(nom)} ?`, [
    { name: 'confirmer', label: 'Cette ferme n\'a plus accès à l\'application. Tapez "OUI" pour confirmer', type: 'text', value: '' },
  ]);
  if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
  try {
    await Api.del(`/plateforme/organisations/${tenantId}`);
    showToast('Ferme supprimée.', 'success');
    window.Views.plateforme.render(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function modifierSlug(container, tenantId, slugActuel) {
  const values = await Modal.open('Modifier le sous-domaine', [
    { name: 'slug', label: 'Sous-domaine (ex: massla → massla.massla.sn)', type: 'text', value: slugActuel },
  ]);
  if (!values) return;
  try {
    await Api.put(`/plateforme/organisations/${tenantId}/slug`, { slug: values.slug });
    showToast('Sous-domaine mis à jour.', 'success');
    window.Views.plateforme.render(container);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderLignesFacturesSaas(factures) {
  if (factures.length === 0) return '<tr><td colspan="7" class="empty">Aucune facture SaaS.</td></tr>';
  return factures
    .map(
      (f) => `<tr>
        <td>${esc(f.organisation_nom)}</td>
        <td>${f.type === 'CONFIGURATION' ? 'Configuration' : 'Abonnement'}</td>
        <td>${esc(f.periode) || '-'}</td>
        <td>${Number(f.montant).toLocaleString('fr-FR')} FCFA</td>
        <td>${fmtDate(f.date_echeance)}</td>
        <td><span class="badge ${FACTURE_SAAS_STATUT_BADGE[f.statut] || 'muted'}">${esc(FACTURE_SAAS_STATUT_LABELS[f.statut] || f.statut)}</span></td>
        <td style="white-space:nowrap">${
          f.statut === 'A_PAYER' || f.statut === 'EN_RETARD'
            ? `<button class="secondary" data-marquer-payee="${f.id}">Marquer payée</button>
               <button class="secondary" data-rappel-whatsapp="${f.id}">Envoyer un rappel WhatsApp</button>`
            : ''
        }</td>
      </tr>`
    )
    .join('');
}

function attacherActionsFactures(scope, factures, container) {
  scope.querySelectorAll('button[data-marquer-payee]').forEach((btn) => {
    btn.addEventListener('click', () => marquerFacturePayee(container, btn.dataset.marquerPayee));
  });
  scope.querySelectorAll('button[data-rappel-whatsapp]').forEach((btn) => {
    btn.addEventListener('click', () => envoyerRappelWhatsapp(btn));
  });
}

async function envoyerRappelWhatsapp(btn) {
  const factureId = btn.dataset.rappelWhatsapp;
  btn.disabled = true;
  const texteOriginal = btn.textContent;
  btn.textContent = 'Envoi…';
  try {
    await Api.post(`/plateforme/factures-saas/${factureId}/rappel-whatsapp`, {});
    showToast('Rappel WhatsApp envoyé.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = texteOriginal;
  }
}

async function marquerFacturePayee(container, factureId) {
  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Marquer la facture comme payée</h3>
        <form id="form-paiement-saas" class="form-grid">
          <label>Moyen de paiement reçu
            <select name="methodePaiement" required>
              <option value="WAVE">Wave</option>
              <option value="VIREMENT">Virement</option>
              <option value="ESPECES">Espèces</option>
              <option value="AUTRE">Autre</option>
            </select>
          </label>
          <label class="span-2">Notes (optionnel)<textarea name="notes" rows="2"></textarea></label>
        </form>
        <div class="modal-actions">
          <button class="secondary" data-action="annuler">Annuler</button>
          <button data-action="confirmer">Confirmer le paiement</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);
  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('[data-action="annuler"]').addEventListener('click', closeModal);
  overlay.querySelector('[data-action="confirmer"]').addEventListener('click', async () => {
    const fd = new FormData(overlay.querySelector('#form-paiement-saas'));
    try {
      await Api.put(`/plateforme/factures-saas/${factureId}`, {
        statut: 'PAYEE',
        methodePaiement: fd.get('methodePaiement'),
        notes: fd.get('notes'),
      });
      showToast('Facture marquée comme payée.', 'success');
      closeModal();
      window.Views.plateforme.render(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function ouvrirAbonnementSaas(container, org, catalogue) {
  const [abonnement, secteurs] = await Promise.all([
    Api.get(`/plateforme/organisations/${org.id}/abonnement-saas`),
    Api.get(`/plateforme/organisations/${org.id}/secteurs`),
  ]);
  const modulesActifs = abonnement?.modules_actifs || [];
  const surPack = modulesActifs.includes(catalogue.packToutCompris.cle);
  const dejaConfigure = !!abonnement;

  const overlay = el(`
    <div class="modal-overlay">
      <div class="modal-box">
        <h3>Abonnement SaaS — ${esc(org.nom)}</h3>

        <div class="panel" style="margin-bottom: 1rem;">
          <h4 style="margin-top:0;">Secteurs de production</h4>
          <p class="desc" id="liste-secteurs">${secteurs.length ? secteurs.map((s) => esc(s.nom)).join(', ') : 'Aucun secteur.'}</p>
          <form id="form-ajout-secteur" class="form-grid" style="margin-bottom:0;">
            <label>Nouveau secteur<input type="text" name="nom" autocomplete="off" placeholder="ex: Élevage bovin" /></label>
            <label style="flex-direction: row; align-items: center; gap: 8px;">
              <input type="checkbox" name="suiviRecolte" style="width:auto" /> Suivre une date de récolte prévue
            </label>
            <button type="submit" class="secondary">Ajouter le secteur</button>
          </form>
        </div>

        <p class="desc">${esc(catalogue.socleEssentiel.label)} — ${catalogue.socleEssentiel.prixMensuelDefaut.toLocaleString('fr-FR')} FCFA/mois (toujours inclus)</p>
        <form id="form-abonnement-saas" class="form-grid">
          <label style="flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" name="pack" style="width:auto" ${surPack ? 'checked' : ''} />
            ${esc(catalogue.packToutCompris.label)} (${catalogue.packToutCompris.prixMensuelDefaut.toLocaleString('fr-FR')} FCFA/mois)
          </label>
          <div id="modules-a-la-carte" style="${surPack ? 'opacity: 0.4; pointer-events: none;' : ''}">
            ${catalogue.modules
              .map(
                (m) => `<label style="flex-direction: row; align-items: center; gap: 8px;">
                  <input type="checkbox" name="module" value="${m.cle}" style="width:auto" ${surPack || modulesActifs.includes(m.cle) ? 'checked' : ''} />
                  ${esc(m.label)} (${m.prixMensuelDefaut.toLocaleString('fr-FR')} FCFA/mois)
                </label>`
              )
              .join('')}
          </div>
          <label>Montant mensuel négocié (FCFA)
            <input type="number" name="montantMensuel" min="1" required value="${abonnement?.montant_mensuel || ''}" />
          </label>
          ${
            dejaConfigure
              ? `<p class="desc">Frais de configuration : ${abonnement.frais_configuration_facture ? 'déjà facturé' : 'non facturé'}.</p>`
              : `<label>Frais de configuration initiale (FCFA, facturé une seule fois)
                   <input type="number" name="fraisConfiguration" min="0" value="${catalogue.fraisConfigurationDefaut}" />
                 </label>`
          }
          <label style="flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" name="actif" style="width:auto" ${abonnement?.actif !== false ? 'checked' : ''} />
            Abonnement actif (décochez pour suspendre sans supprimer l'historique)
          </label>
          <label>Numéro WhatsApp (relances de facturation)
            <input type="tel" name="telephoneContact" placeholder="ex: +221771234567" value="${esc(abonnement?.telephone_contact || '')}" />
          </label>
        </form>
        <div class="modal-actions">
          <button class="secondary" data-action="annuler">Annuler</button>
          <button data-action="enregistrer">Enregistrer</button>
        </div>
      </div>
    </div>
  `);
  document.body.appendChild(overlay);
  const closeModal = () => overlay.remove();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('[data-action="annuler"]').addEventListener('click', closeModal);

  overlay.querySelector('#form-ajout-secteur').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const nom = (fd.get('nom') || '').trim();
    if (!nom) return;
    try {
      const nouveau = await Api.post(`/plateforme/organisations/${org.id}/secteurs`, {
        nom,
        suiviRecolte: fd.get('suiviRecolte') === 'on',
      });
      secteurs.push(nouveau);
      overlay.querySelector('#liste-secteurs').textContent = secteurs.map((s) => s.nom).join(', ');
      e.target.reset();
      showToast('Secteur ajouté.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  overlay.querySelector('input[name="pack"]').addEventListener('change', (e) => {
    overlay.querySelector('#modules-a-la-carte').style.opacity = e.target.checked ? '0.4' : '1';
    overlay.querySelector('#modules-a-la-carte').style.pointerEvents = e.target.checked ? 'none' : 'auto';
    // Coche/décoche visuellement chaque module pour que "Pack tout compris" se lise vraiment comme
    // "tout est inclus" — jusqu'ici les cases restaient grisées mais décochées, ce qui donnait
    // l'impression trompeuse que rien n'était sélectionné alors que l'enregistrement était correct.
    overlay.querySelectorAll('#modules-a-la-carte input[name="module"]').forEach((cb) => {
      cb.checked = e.target.checked;
    });
  });

  overlay.querySelector('[data-action="enregistrer"]').addEventListener('click', async () => {
    const fd = new FormData(overlay.querySelector('#form-abonnement-saas'));
    const surPackCoche = fd.get('pack') === 'on';
    const modules = surPackCoche ? [catalogue.packToutCompris.cle] : fd.getAll('module');
    try {
      await Api.put(`/plateforme/organisations/${org.id}/abonnement-saas`, {
        modulesActifs: modules,
        montantMensuel: Number(fd.get('montantMensuel')),
        fraisConfiguration: dejaConfigure ? undefined : Number(fd.get('fraisConfiguration') || 0),
        actif: fd.get('actif') === 'on',
        telephoneContact: (fd.get('telephoneContact') || '').trim() || null,
      });
      showToast('Abonnement enregistré.', 'success');
      closeModal();
      window.Views.plateforme.render(container);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

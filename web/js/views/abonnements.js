window.Views = window.Views || {};

const JOURS_SEMAINE = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI', 'DIMANCHE'];

window.Views.abonnements = {
  async render(container) {
    const [abonnements, clients, produits] = await Promise.all([
      Api.get('/abonnements'),
      Api.get('/clients?type=B2C'),
      Api.get('/catalogue/produits'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvel abonnement (panier récurrent B2C)</h2>
        <p class="desc">Gestion des paniers récurrents et paiements associés — le client reçoit automatiquement le même produit chaque semaine/quinzaine/mois.</p>
        <form id="form-abonnement" class="form-grid" autocomplete="off">
          <label>Client
            <select name="client_id" required>${clients.map((c) => `<option value="${c.id}">${esc(c.nom)}</option>`).join('')}</select>
          </label>
          <label>Produit
            <select name="produit_id" required>${produits.map((p) => `<option value="${p.id}">${esc(p.nom)} (${fmt(p.prix_unitaire_b2c)} FCFA)</option>`).join('')}</select>
          </label>
          <label>Quantité<input type="number" name="quantite" min="1" value="1" required /></label>
          <label>Fréquence
            <select name="frequence">
              <option value="HEBDOMADAIRE">Hebdomadaire</option>
              <option value="BIMENSUEL">Bimensuel</option>
              <option value="MENSUEL">Mensuel</option>
            </select>
          </label>
          <label>Jour de livraison
            <select name="jour_livraison">${JOURS_SEMAINE.map((j) => `<option value="${j}">${j.charAt(0) + j.slice(1).toLowerCase()}</option>`).join('')}</select>
          </label>
          <button type="submit">Créer l'abonnement</button>
        </form>
      </div>

      <div class="panel">
        <div class="panel-row">
          <div>
            <h2>Abonnements actifs</h2>
            <p class="desc" style="margin-bottom:0">Génère chaque jour les commandes correspondant aux abonnements dus (simulateur du job planifié).</p>
          </div>
          <button id="btn-generer">Générer les commandes du jour</button>
        </div>
        <table>
          <thead><tr><th>Client</th><th>Produit</th><th>Quantité</th><th>Fréquence</th><th>Jour</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${
              abonnements.length
                ? abonnements
                    .map(
                      (a) => `<tr>
                        <td>${esc(a.client_nom)}</td>
                        <td>${esc(a.produit_nom)}</td>
                        <td class="num">${fmt(a.quantite)}</td>
                        <td>${esc(a.frequence)}</td>
                        <td>${esc(a.jour_livraison)}</td>
                        <td><span class="badge ${a.actif ? 'ok' : 'muted'}">${a.actif ? 'Actif' : 'Suspendu'}</span></td>
                        <td>
                          <button class="secondary" data-toggle="${a.id}" data-actif="${a.actif}">${a.actif ? 'Suspendre' : 'Réactiver'}</button>
                        </td>
                      </tr>`
                    )
                    .join('')
                : '<tr><td colspan="7" class="empty">Aucun abonnement.</td></tr>'
            }
          </tbody>
        </table>
      </div>
    `;

    container.querySelector('#form-abonnement').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/abonnements', {
          client_id: Number(fd.get('client_id')),
          produit_id: Number(fd.get('produit_id')),
          quantite: Number(fd.get('quantite')),
          frequence: fd.get('frequence'),
          jour_livraison: fd.get('jour_livraison'),
        });
        showToast('Abonnement créé.', 'success');
        window.Views.abonnements.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#btn-generer').addEventListener('click', async () => {
      try {
        const res = await Api.post('/abonnements/generer-commandes', {});
        showToast(`${res.creees} commande(s) générée(s) pour ${res.jour}${res.echecs.length ? ` (${res.echecs.length} échec(s))` : ''}.`, res.echecs.length ? 'warn' : 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.put(`/abonnements/${btn.dataset.toggle}/statut`, { actif: btn.dataset.actif !== 'true' });
          showToast('Statut mis à jour.', 'success');
          window.Views.abonnements.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

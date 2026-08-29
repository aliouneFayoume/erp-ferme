window.Views = window.Views || {};

window.Views.catalogue = {
  async render(container) {
    const user = Api.getUser();
    const [produits, secteurs] = await Promise.all([Api.get('/catalogue/produits'), Api.get('/production/secteurs')]);

    container.innerHTML = `
      ${
        user.role === 'admin'
          ? `<div class="panel">
              <h2>Nouveau produit</h2>
              <p class="desc">Grille tarifaire à 3 niveaux : standard (B2C), restaurant (B2B), grossiste (B2B gros volumes).</p>
              <form id="form-produit" class="form-grid" autocomplete="off">
                <label>Secteur
                  <select name="secteur_id" required>${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}</select>
                </label>
                <label>Nom<input type="text" name="nom" required /></label>
                <label>Unité
                  <select name="unite_mesure">
                    <option value="TETE">Tête</option>
                    <option value="KG">Kg</option>
                    <option value="CAISSE">Caisse</option>
                    <option value="BOTTES">Bottes</option>
                  </select>
                </label>
                <label>Prix standard / B2C (FCFA)<input type="number" name="prix_unitaire_b2c" required /></label>
                <label>Prix restaurant / B2B (FCFA)<input type="number" name="prix_unitaire_b2b" required /></label>
                <label>Prix grossiste (FCFA, optionnel)<input type="number" name="prix_unitaire_grossiste" /></label>
                <label>Stock initial<input type="number" name="quantite_initiale" value="0" /></label>
                <button type="submit">Créer</button>
              </form>
            </div>`
          : ''
      }

      <div class="panel">
        <h2>Catalogue & stock</h2>
        <p class="desc">Double pool de stock : réservations séparées B2B / B2C pour éviter les surventes croisées.</p>
        <table>
          <thead>
            <tr><th>Produit</th><th>Secteur</th><th>Standard</th><th>Restaurant</th><th>Grossiste</th><th>Disponible</th><th>Réservé B2B</th><th>Réservé B2C</th><th></th></tr>
          </thead>
          <tbody>
            ${produits
              .map(
                (p) => `<tr>
                  <td>${esc(p.nom)}</td>
                  <td>${esc(p.secteur_nom)}</td>
                  <td class="num">${fmt(p.prix_unitaire_b2c)}</td>
                  <td class="num">${fmt(p.prix_unitaire_b2b)}</td>
                  <td class="num">${p.prix_unitaire_grossiste != null ? fmt(p.prix_unitaire_grossiste) : `<span class="badge muted">= restaurant</span>`}</td>
                  <td class="num">
                    ${p.quantite_disponible <= p.seuil_alerte ? `<span class="badge warn">${fmt(p.quantite_disponible)}</span>` : fmt(p.quantite_disponible)}
                  </td>
                  <td class="num">${fmt(p.quantite_reservee_b2b)}</td>
                  <td class="num">${fmt(p.quantite_reservee_b2c)}</td>
                  <td>${user.role === 'admin' ? `<button class="secondary" data-edit="${p.id}" data-b2b="${p.prix_unitaire_b2b}" data-b2c="${p.prix_unitaire_b2c}" data-gros="${p.prix_unitaire_grossiste ?? ''}">Tarifs</button>` : ''}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    const formProduit = container.querySelector('#form-produit');
    if (formProduit) {
      formProduit.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          await Api.post('/catalogue/produits', {
            secteur_id: Number(fd.get('secteur_id')),
            nom: fd.get('nom'),
            unite_mesure: fd.get('unite_mesure'),
            prix_unitaire_b2b: Number(fd.get('prix_unitaire_b2b')),
            prix_unitaire_b2c: Number(fd.get('prix_unitaire_b2c')),
            prix_unitaire_grossiste: fd.get('prix_unitaire_grossiste') ? Number(fd.get('prix_unitaire_grossiste')) : null,
            quantite_initiale: Number(fd.get('quantite_initiale') || 0),
          });
          showToast('Produit créé.', 'success');
          window.Views.catalogue.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    }

    container.querySelectorAll('button[data-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const values = await Modal.open('Modifier les tarifs', [
          { name: 'b2c', label: 'Prix standard / B2C (FCFA)', type: 'number', value: btn.dataset.b2c },
          { name: 'b2b', label: 'Prix restaurant / B2B (FCFA)', type: 'number', value: btn.dataset.b2b },
          { name: 'gros', label: 'Prix grossiste (FCFA)', type: 'number', value: btn.dataset.gros },
        ]);
        if (!values) return;
        try {
          await Api.put(`/catalogue/produits/${btn.dataset.edit}/tarifs`, {
            prix_unitaire_b2b: Number(values.b2b),
            prix_unitaire_b2c: Number(values.b2c),
            prix_unitaire_grossiste: values.gros ? Number(values.gros) : null,
          });
          showToast('Tarifs mis à jour.', 'success');
          window.Views.catalogue.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

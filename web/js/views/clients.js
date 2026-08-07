window.Views = window.Views || {};

window.Views.clients = {
  async render(container) {
    const clients = await Api.get('/clients');
    const moi = Api.getUser();

    container.innerHTML = `
      <div class="panel">
        <h2>Nouveau client</h2>
        <p class="desc">Un point GPS précis est obligatoire (cliquez sur la carte pour le définir) — pas d'adresse textuelle seule.</p>
        <form id="form-client" class="form-grid">
          <label>Nom<input type="text" name="nom" required /></label>
          <label>Type
            <select name="type_client" required>
              <option value="B2C">Particulier (B2C)</option>
              <option value="B2B">Professionnel (B2B)</option>
            </select>
          </label>
          <label>Catégorie tarifaire
            <select name="categorie_tarifaire">
              <option value="standard">Standard</option>
              <option value="restaurant">Restaurant</option>
              <option value="grossiste">Grossiste</option>
            </select>
          </label>
          <label>Téléphone<input type="text" name="telephone" required /></label>
          <label>Adresse (repère)<input type="text" name="adresse" /></label>
          <label>Latitude GPS<input type="number" step="0.00000001" name="gps_lat" required /></label>
          <label>Longitude GPS<input type="number" step="0.00000001" name="gps_lng" required /></label>
          <label>Limite de crédit (B2B, FCFA)<input type="number" name="limite_credit" value="0" /></label>
          <button type="submit">Créer le client</button>
        </form>
        <div id="pick-map" class="gps-map"></div>
      </div>

      <div class="panel">
        <h2>Clients (${clients.length})</h2>
        <table>
          <thead><tr><th>Nom</th><th>Type</th><th>Catégorie</th><th>Téléphone</th><th>Encours / Limite</th><th>GPS</th><th></th></tr></thead>
          <tbody>
            ${clients
              .map(
                (c) => `<tr>
                  <td>${esc(c.nom)}${c.est_abonne ? ' <span class="badge info">abonné</span>' : ''}</td>
                  <td><span class="badge ${c.type_client === 'B2B' ? 'muted' : 'ok'}">${esc(c.type_client)}</span></td>
                  <td>${esc(c.categorie_tarifaire) || '-'}</td>
                  <td>${esc(c.telephone)}</td>
                  <td class="num">${c.type_client === 'B2B' ? `${fmt(c.solde_encours)} / ${fmt(c.limite_credit)}` : '-'}</td>
                  <td class="num">${Number(c.gps_lat).toFixed(4)}, ${Number(c.gps_lng).toFixed(4)}</td>
                  <td>
                    <button class="secondary" data-generer-pin="${c.id}">Code portail</button>
                    ${moi.role === 'admin' ? `<button class="danger" data-supprimer="${c.id}">Supprimer</button>` : ''}
                  </td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    let picked = null;
    if (window.L) {
      const map = L.map('pick-map').setView([14.7167, -17.4677], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
      let marker = null;
      clients.forEach((c) => {
        L.marker([c.gps_lat, c.gps_lng]).addTo(map).bindPopup(`${esc(c.nom)} (${esc(c.type_client)})`);
      });
      map.on('click', (e) => {
        picked = e.latlng;
        if (marker) marker.remove();
        marker = L.marker([picked.lat, picked.lng]).addTo(map);
        container.querySelector('input[name="gps_lat"]').value = picked.lat.toFixed(8);
        container.querySelector('input[name="gps_lng"]').value = picked.lng.toFixed(8);
      });
    } else {
      container.querySelector('#pick-map').outerHTML = '<p class="empty">Carte indisponible (hors-ligne).</p>';
    }

    container.querySelector('#form-client').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/clients', {
          nom: fd.get('nom'),
          type_client: fd.get('type_client'),
          categorie_tarifaire: fd.get('categorie_tarifaire'),
          telephone: fd.get('telephone'),
          adresse: fd.get('adresse'),
          gps_lat: Number(fd.get('gps_lat')),
          gps_lng: Number(fd.get('gps_lng')),
          limite_credit: Number(fd.get('limite_credit') || 0),
        });
        showToast('Client créé.', 'success');
        window.Views.clients.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-generer-pin]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const { pin, client } = await Api.post(`/clients/${btn.dataset.genererPin}/pin`, {});
          await Modal.open(`Code portail pour ${client.nom}`, [
            { name: 'pin', label: `Code à transmettre au client (${client.telephone}) — ne sera plus jamais affiché`, type: 'text', value: pin },
          ]);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const c = clients.find((x) => x.id === Number(btn.dataset.supprimer));
        const values = await Modal.open(`Supprimer ${c.nom} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/clients/${btn.dataset.supprimer}`);
          showToast('Client supprimé.', 'success');
          window.Views.clients.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

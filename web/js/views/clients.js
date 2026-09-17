window.Views = window.Views || {};

window.Views.clients = {
  async render(container) {
    const clients = await Api.get('/clients');
    const moi = Api.getUser();

    container.innerHTML = `
      <div class="panel">
        <h2>Nouveau client</h2>
        <p class="desc">Un point GPS précis est obligatoire — pas d'adresse textuelle seule. Utilisez le bouton "Choisir sur la carte" (ou collez des coordonnées, par exemple une position partagée sur WhatsApp).</p>
        <form id="form-client" class="form-grid" autocomplete="off">
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
        </form>
        <div class="panel-row" style="margin-top:12px">
          <button type="button" class="secondary" id="btn-choisir-carte">📍 Choisir le point sur la carte</button>
          <button type="submit" form="form-client">Créer le client</button>
        </div>
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
                  <td class="actions-cell">
                    <button class="secondary" data-modifier="${c.id}">Modifier</button>
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

    const btnChoisirCarte = container.querySelector('#btn-choisir-carte');
    if (window.L) {
      btnChoisirCarte.addEventListener('click', async () => {
        const latInput = container.querySelector('input[name="gps_lat"]');
        const lngInput = container.querySelector('input[name="gps_lng"]');
        const point = await MapPicker.open({
          lat: latInput.value ? Number(latInput.value) : null,
          lng: lngInput.value ? Number(lngInput.value) : null,
          markers: clients.map((c) => ({ lat: c.gps_lat, lng: c.gps_lng, label: `${esc(c.nom)} (${esc(c.type_client)})` })),
        });
        if (point) {
          latInput.value = point.lat.toFixed(8);
          lngInput.value = point.lng.toFixed(8);
        }
      });
    } else {
      btnChoisirCarte.disabled = true;
      btnChoisirCarte.title = 'Carte indisponible (hors-ligne).';
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

    container.querySelectorAll('button[data-modifier]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const c = clients.find((x) => x.id === Number(btn.dataset.modifier));
        const values = await Modal.open(`Modifier ${c.nom}`, [
          { name: 'nom', label: 'Nom', type: 'text', value: c.nom },
          { name: 'telephone', label: 'Téléphone', type: 'text', value: c.telephone },
          {
            name: 'categorie_tarifaire', label: 'Catégorie tarifaire', type: 'select', value: c.categorie_tarifaire || 'standard',
            options: [
              { value: 'standard', label: 'Standard' },
              { value: 'restaurant', label: 'Restaurant' },
              { value: 'grossiste', label: 'Grossiste' },
            ],
          },
          { name: 'adresse', label: 'Adresse (repère)', type: 'text', value: c.adresse || '' },
          { name: 'gps_lat', label: 'Latitude GPS', type: 'number', value: c.gps_lat },
          { name: 'gps_lng', label: 'Longitude GPS', type: 'number', value: c.gps_lng },
          { name: 'limite_credit', label: 'Limite de crédit (B2B, FCFA)', type: 'number', value: c.limite_credit || 0 },
        ]);
        if (!values) return;
        if (!values.gps_lat || !values.gps_lng) {
          showToast("Un point GPS précis est obligatoire pour l'adressage client.", 'error');
          return;
        }
        try {
          await Api.put(`/clients/${c.id}`, {
            ...values,
            gps_lat: Number(values.gps_lat),
            gps_lng: Number(values.gps_lng),
            limite_credit: Number(values.limite_credit) || 0,
          });
          showToast('Client mis à jour.', 'success');
          window.Views.clients.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
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

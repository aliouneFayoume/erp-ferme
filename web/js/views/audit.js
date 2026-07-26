window.Views = window.Views || {};

window.Views.audit = {
  async render(container) {
    const logs = await Api.get('/audit');

    container.innerHTML = `
      <div class="panel">
        <h2>Journal d'audit</h2>
        <p class="desc">Traçabilité obligatoire : auteur et horodatage de chaque action critique (soft delete, aucune suppression physique).</p>
        <table>
          <thead><tr><th>Horodatage</th><th>Table</th><th>Action</th><th>Utilisateur</th><th>Détails</th></tr></thead>
          <tbody>
            ${logs
              .map(
                (l) => `<tr>
                  <td>${new Date(l.cree_le).toLocaleString('fr-FR')}</td>
                  <td>${esc(l.table_name)}</td>
                  <td><span class="badge info">${esc(l.action)}</span></td>
                  <td>${esc(l.utilisateur_nom) || '-'}</td>
                  <td style="font-family:ui-monospace,monospace;font-size:11px">${l.details ? esc(JSON.stringify(l.details)) : ''}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  },
};

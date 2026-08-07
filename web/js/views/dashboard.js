window.Views = window.Views || {};

window.Views.dashboard = {
  async render(container) {
    const stats = await Api.get('/dashboard/stats');

    const alertes = [];
    if (stats.recoltesProches > 0) {
      alertes.push(`${stats.recoltesProches} récolte(s) maraîchère(s) prévue(s) sous 7 jours.`);
    }
    if (stats.produitsSousSeuil > 0) {
      alertes.push(`${stats.produitsSousSeuil} produit(s) sous le seuil de réapprovisionnement — voir Fournisseurs.`);
    }

    container.innerHTML = `
      ${
        alertes.length
          ? `<div class="panel alert-panel">
              <h2>⚠ Alertes</h2>
              <ul class="alert-list">${alertes.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
            </div>`
          : ''
      }

      <div class="grid-stats">
        ${statCard("Chiffre d'affaires du jour", `${fmt(stats.chiffreAffairesJour)} FCFA`, null, 'var(--finance)')}
        ${statCard('Commandes B2C du jour', stats.commandesB2C, null, 'var(--clients)')}
        ${statCard('Stock Avicole disponible', fmt(stats.stockAvicole), 'toutes unités confondues', 'var(--avicole)')}
        ${statCard('Encours B2B total', `${fmt(stats.encoursB2B)} FCFA`, 'crédit accordé aux pros', 'var(--stock)')}
        ${statCard('Caisses chauffeur ouvertes', stats.caissesOuvertes, null, 'var(--livraison)')}
        ${statCard('Lots de production actifs', stats.lotsActifs, null, 'var(--maraicher)')}
      </div>

      ${
        stats.chiffreAffairesParJour && stats.chiffreAffairesParJour.length >= 2
          ? `<div class="panel">
              <h2>Chiffre d'affaires — 14 derniers jours</h2>
              <p class="desc">Évolution des commandes facturées (hors annulées).</p>
              ${lineChartSvg(stats.chiffreAffairesParJour, { color: 'var(--finance)', unit: ' FCFA' })}
            </div>`
          : ''
      }

      <div class="panel">
        <h2>Bienvenue sur le tableau de bord</h2>
        <p class="desc">
          Vue transversale de l'exploitation. Utilisez le menu à gauche pour gérer la production,
          le catalogue, les commandes B2B/B2C, la logistique et les finances.
        </p>
      </div>
    `;
  },
};

function statCard(label, value, sub, accent) {
  return `
    <div class="stat-card" style="border-top-color:${accent}">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>
  `;
}

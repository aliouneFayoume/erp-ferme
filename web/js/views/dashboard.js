window.Views = window.Views || {};

window.Views.dashboard = {
  async render(container) {
    const stats = await Api.get('/dashboard/stats');

    container.innerHTML = `
      <div class="grid-stats">
        ${statCard("Chiffre d'affaires du jour", `${fmt(stats.chiffreAffairesJour)} FCFA`, null, 'var(--finance)')}
        ${statCard('Commandes B2C du jour', stats.commandesB2C, null, 'var(--clients)')}
        ${statCard('Stock Avicole disponible', fmt(stats.stockAvicole), 'toutes unités confondues', 'var(--avicole)')}
        ${statCard('Encours B2B total', `${fmt(stats.encoursB2B)} FCFA`, 'crédit accordé aux pros', 'var(--danger)')}
        ${statCard('Caisses chauffeur ouvertes', stats.caissesOuvertes, null, 'var(--livraison)')}
        ${statCard('Lots de production actifs', stats.lotsActifs, null, 'var(--maraicher)')}
        ${statCard('Récoltes proches (≤7j)', stats.recoltesProches, 'Maraîcher', stats.recoltesProches > 0 ? 'var(--warn)' : 'var(--maraicher)')}
      </div>
      <div class="panel">
        <h2>Bienvenue sur le tableau de bord</h2>
        <p class="desc">
          Vue transversale de l'exploitation. Utilisez les onglets ci-dessus pour gérer la production,
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

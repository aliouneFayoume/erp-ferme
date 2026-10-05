window.Views = window.Views || {};

window.Views.dashboard = {
  async render(container) {
    const stats = await Api.get('/dashboard/stats');

    const alertes = [];
    if (stats.recoltesProches > 0) {
      alertes.push(`${stats.recoltesProches} récolte(s) prévue(s) sous 7 jours.`);
    }
    if (stats.produitsSousSeuil > 0) {
      alertes.push(`${stats.produitsSousSeuil} produit(s) sous le seuil de réapprovisionnement — voir Fournisseurs.`);
    }

    container.innerHTML = `
      ${
        alertes.length
          ? `<div class="panel alert-panel" role="status">
              <h2>Alertes</h2>
              <ul class="alert-list">${alertes.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
            </div>`
          : ''
      }

      <div class="grid-stats">
        ${statCard("Chiffre d'affaires du jour", `${fmt(stats.chiffreAffairesJour)} FCFA`, null, false, true)}
        ${statCard('Commandes B2C du jour', stats.commandesB2C)}
        ${statCard('Stock total disponible', fmt(stats.stockTotal), 'tous secteurs, toutes unités confondues')}
        ${statCard('Encours B2B total', `${fmt(stats.encoursB2B)} FCFA`, 'crédit accordé aux pros')}
        ${statCard('Caisses chauffeur ouvertes', stats.caissesOuvertes)}
        ${statCard('Lots de production actifs', stats.lotsActifs)}
        ${statCard('Récoltes proches (≤7j)', stats.recoltesProches, 'secteurs à suivi de récolte', stats.recoltesProches > 0)}
      </div>

      ${
        stats.chiffreAffairesParJour && stats.chiffreAffairesParJour.length >= 2
          ? `<div class="panel">
              <h2>Chiffre d'affaires — 14 derniers jours</h2>
              <p class="desc">Évolution des commandes facturées (hors annulées).</p>
              ${lineChartSvg(stats.chiffreAffairesParJour, { unit: ' FCFA' })}
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

// attention : valeur à surveiller (filet vert vif) ; brand : l'indicateur principal de l'écran, fond Sahel (un seul).
// L'unité en fin de valeur ("88 600 FCFA") passe en plus petit, comme dans le kit.
function statCard(label, value, sub, attention, brand) {
  const m = typeof value === 'string' ? value.match(/^(.*\d)\s+([A-Za-zÀ-ÿ%]+)$/) : null;
  const valeur = m ? `${m[1]}<span class="unit">${m[2]}</span>` : value;
  return `
    <div class="stat-card${attention ? ' attention' : ''}${brand ? ' brand' : ''}">
      <div class="label">${label}</div>
      <div class="value">${valeur}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>
  `;
}

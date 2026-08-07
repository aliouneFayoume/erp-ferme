window.Views = window.Views || {};

window.Views.logistique = {
  async render(container) {
    const user = Api.getUser();
    if (user.role === 'livreur') return renderLivreur(container);
    return renderGestion(container);
  },
};

const CACHE_TOURNEE_KEY = 'erp_cache_tournee_livreur';

async function renderLivreur(container) {
  let tourneeRes, caisses, horsLigne = false;
  try {
    [tourneeRes, caisses] = await Promise.all([Api.get('/logistique/tournees'), Api.get('/logistique/caisse')]);
    localStorage.setItem(CACHE_TOURNEE_KEY, JSON.stringify({ tourneeRes, caisses, ts: new Date().toISOString() }));
  } catch (err) {
    if (!err.reseau) throw err;
    const cache = localStorage.getItem(CACHE_TOURNEE_KEY);
    if (!cache) {
      container.innerHTML = `<div class="panel"><p class="empty">Hors ligne et aucune tournée en cache. Reconnectez-vous une fois pour la charger.</p></div>`;
      return;
    }
    const parsed = JSON.parse(cache);
    tourneeRes = parsed.tourneeRes;
    caisses = parsed.caisses;
    horsLigne = parsed.ts;
  }

  const { depot, arrets: tournees, trace: traceReelle } = tourneeRes;
  const distanceTotaleKm = tournees.reduce((s, t) => s + Number(t.distance_depuis_precedent_km || 0), 0);
  const dureeTotaleConnue = tournees.every((t) => t.duree_depuis_precedent_min != null);
  const dureeTotaleMin = tournees.reduce((s, t) => s + Number(t.duree_depuis_precedent_min || 0), 0);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const caisseDuJour = caisses.find((c) => String(c.date_caisse).slice(0, 10) === aujourdhui);
  const fileHorsLigne = await OfflineQueue.lire();
  const caisseOuvertureEnAttente = fileHorsLigne.some((i) => i.path === '/logistique/caisse/ouvrir');
  const livraisonsEnAttente = new Set(
    fileHorsLigne.filter((i) => i.path.startsWith('/logistique/livraisons/')).map((i) => i.path.split('/')[3])
  );

  let caisseHtml;
  if (caisseOuvertureEnAttente) {
    caisseHtml = `<span class="badge warn">Ouverture en attente d'envoi (hors ligne)</span>`;
  } else if (!caisseDuJour) {
    caisseHtml = `<button id="btn-ouvrir-caisse">Ouvrir ma caisse du jour</button>`;
  } else if (caisseDuJour.statut === 'OUVERTE') {
    caisseHtml = `<span class="badge ok">Ouverte — ${fmt(caisseDuJour.montant_theorique)} FCFA encaissés</span>`;
  } else {
    caisseHtml = `<span class="badge muted">Clôturée par le comptable — ${fmt(caisseDuJour.montant_theorique)} FCFA théorique, ${fmt(caisseDuJour.montant_depose)} FCFA déposé (écart ${fmt(caisseDuJour.ecart)})</span>`;
  }

  container.innerHTML = `
    ${horsLigne ? `<div class="panel"><p class="empty" style="margin:0">Hors ligne — dernières données connues (${new Date(horsLigne).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}). Vos actions seront envoyées à la reconnexion.</p></div>` : ''}
    <div class="panel">
      <div class="panel-row">
        <div>
          <h2>Caisse chauffeur virtuelle</h2>
          <p class="desc" style="margin-bottom:0">Ouverture journalière obligatoire avant tournée.</p>
        </div>
        ${caisseHtml}
      </div>
    </div>

    <div class="panel">
      <div class="panel-row">
        <div>
          <h2>Ma tournée du jour</h2>
          <p class="desc" style="margin-bottom:0">Ordre de passage optimisé (TMS) depuis le dépôt de la ferme (Diamniadio). Les livraisons apparaissent ici une fois qu'un Administrateur ou le Comptable les assigne depuis l'onglet Logistique (côté gestion), pour une commande au statut PREPAREE.</p>
        </div>
        ${
          tournees.length
            ? `<span class="badge info">${distanceTotaleKm.toFixed(1)} km${dureeTotaleConnue ? ` · ${Math.round(dureeTotaleMin)} min` : ' (estimation à vol d\'oiseau)'}</span>`
            : ''
        }
      </div>
      <div id="tournee-map" class="gps-map"></div>
      <div class="card-list" style="margin-top:14px" id="tournee-list"></div>
    </div>
  `;

  if (window.L) {
    const map = L.map('tournee-map').setView([depot.lat, depot.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    const depotIcon = L.divIcon({
      className: '',
      html: `<div style="background:#1A1A1A;color:#FFFFFF;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)">🏠</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    L.marker([depot.lat, depot.lng], { icon: depotIcon }).addTo(map).bindPopup('Dépôt — Ferme Massla (Diamniadio)');

    const pointsOrdre = [[depot.lat, depot.lng]];
    tournees.forEach((t) => {
      const numeroIcon = L.divIcon({
        className: '',
        html: `<div style="background:var(--livraison);color:white;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)">${t.ordre}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([t.gps_lat, t.gps_lng], { icon: numeroIcon })
        .addTo(map)
        .bindPopup(`#${t.ordre} — ${esc(t.client_nom)}<br>${esc(t.numero_commande)}`);
      pointsOrdre.push([t.gps_lat, t.gps_lng]);
    });

    // Tracé routier réel (OpenRouteService) quand disponible — sinon repli en ligne droite
    // pointillée entre les arrêts, pour toujours afficher quelque chose.
    if (traceReelle && traceReelle.length > 1) {
      L.polyline(traceReelle, { color: '#4A7FA5', weight: 4, opacity: 0.75 }).addTo(map);
      map.fitBounds(traceReelle, { padding: [24, 24] });
    } else if (pointsOrdre.length > 1) {
      L.polyline(pointsOrdre, { color: '#4A7FA5', weight: 3, opacity: 0.6, dashArray: '6 6' }).addTo(map);
      map.fitBounds(pointsOrdre, { padding: [24, 24] });
    }
  }

  const list = container.querySelector('#tournee-list');
  list.innerHTML = tournees.length
    ? tournees
        .map((t) => {
          const enAttente = livraisonsEnAttente.has(String(t.livraison_id));
          return `
        <div class="lot-card">
          <div class="panel-row" style="margin-bottom:0">
            <div class="code">Arrêt #${t.ordre} — ${esc(t.client_nom)}</div>
            <span class="badge info">${t.distance_depuis_precedent_km} km${t.duree_depuis_precedent_min != null ? ` · ${Math.round(t.duree_depuis_precedent_min)} min` : ''}</span>
          </div>
          <div class="meta">${esc(t.adresse) || ''} · GPS ${Number(t.gps_lat).toFixed(4)}, ${Number(t.gps_lng).toFixed(4)}</div>
          <div class="kpi"><span>Commande</span><b>${esc(t.numero_commande)}</b></div>
          <div class="kpi"><span>Montant</span><b>${fmt(t.montant_total)} FCFA</b></div>
          <div class="kpi"><span>Statut</span><b>${esc(t.statut)}</b></div>
          ${
            enAttente
              ? `<div style="margin-top:10px"><span class="badge warn">Livraison en attente d'envoi (hors ligne)</span></div>`
              : `<div style="margin-top:10px;display:flex;flex-direction:column;gap:8px">
            <input type="text" placeholder="Preuve de livraison (nom du réceptionnaire, signature...)" class="input-preuve" data-id="${t.livraison_id}" />
            <div style="display:flex;gap:8px">
              <input type="number" placeholder="Montant encaissé" class="input-encaissement" data-id="${t.livraison_id}" style="flex:1" />
              <select class="select-mode-paiement" data-id="${t.livraison_id}" style="flex:0 0 130px">
                <option value="ESPECES">Espèces</option>
                <option value="WAVE">Wave</option>
                <option value="ORANGE_MONEY">Orange Money</option>
              </select>
            </div>
            <button class="btn-terminer" data-id="${t.livraison_id}">Livré</button>
          </div>`
          }
        </div>
      `;
        })
        .join('')
    : '<div class="empty">Aucune livraison prévue aujourd\'hui.</div>';

  const btnOuvrir = container.querySelector('#btn-ouvrir-caisse');
  if (btnOuvrir) {
    btnOuvrir.addEventListener('click', async () => {
      try {
        await Api.post('/logistique/caisse/ouvrir', {});
        showToast('Caisse ouverte.', 'success');
        window.Views.logistique.render(container);
      } catch (err) {
        if (err.reseau) {
          await OfflineQueue.ajouter({ method: 'POST', path: '/logistique/caisse/ouvrir', body: {}, label: 'Ouverture de caisse' });
          showToast("Hors ligne : ouverture de caisse enregistrée, sera envoyée à la reconnexion.", 'info');
          window.Views.logistique.render(container);
        } else {
          showToast(err.message, 'error');
        }
      }
    });
  }

  container.querySelectorAll('.btn-terminer').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = container.querySelector(`.input-encaissement[data-id="${btn.dataset.id}"]`);
      const modeSelect = container.querySelector(`.select-mode-paiement[data-id="${btn.dataset.id}"]`);
      const preuveInput = container.querySelector(`.input-preuve[data-id="${btn.dataset.id}"]`);
      const montant_encaisse = input.value ? Number(input.value) : 0;
      if (!preuveInput.value.trim()) {
        showToast('Merci de renseigner une preuve de livraison (nom du réceptionnaire, signature...).', 'error');
        return;
      }
      const path = `/logistique/livraisons/${btn.dataset.id}/statut`;
      const payload = {
        statut: 'TERMINEE',
        montant_encaisse,
        methode_paiement: modeSelect.value,
        preuve_livraison: preuveInput.value.trim(),
      };
      try {
        await Api.put(path, payload);
        showToast('Livraison marquée terminée.', 'success');
        window.Views.logistique.render(container);
      } catch (err) {
        if (err.reseau) {
          await OfflineQueue.ajouter({ method: 'PUT', path, body: payload, label: `Livraison ${btn.dataset.id}` });
          showToast('Hors ligne : livraison enregistrée, sera envoyée à la reconnexion.', 'info');
          window.Views.logistique.render(container);
        } else {
          showToast(err.message, 'error');
        }
      }
    });
  });
}

async function renderGestion(container) {
  const user = Api.getUser();
  const [caisses, commandes, livreursRes, livraisons] = await Promise.all([
    Api.get('/logistique/caisse'),
    Api.get('/commandes'),
    Api.get('/utilisateurs?role=livreur'),
    Api.get('/logistique/livraisons'),
  ]);
  const livreurs = livreursRes.filter((l) => l.actif);

  const commandesPreparees = commandes.filter((c) => c.statut === 'PREPAREE');

  container.innerHTML = `
    <div class="panel">
      <h2>Caisses chauffeur</h2>
      <p class="desc">Rapprochement entre encaissements théoriques (application) et dépôt réel déclaré par le comptable.</p>
      <table>
        <thead><tr><th>Date</th><th>Livreur</th><th>Statut</th><th>Théorique</th><th>Déposé</th><th>Écart</th><th></th></tr></thead>
        <tbody>
          ${
            caisses.length
              ? caisses
                  .map(
                    (c) => `<tr>
                      <td>${fmtDate(c.date_caisse)}</td>
                      <td>${esc(c.livreur_nom)}</td>
                      <td><span class="badge ${c.statut === 'OUVERTE' ? 'warn' : 'ok'}">${esc(c.statut)}</span></td>
                      <td class="num">${fmt(c.montant_theorique)}</td>
                      <td class="num">${c.montant_depose != null ? fmt(c.montant_depose) : '-'}</td>
                      <td class="num">${c.ecart != null ? fmt(c.ecart) : '-'}</td>
                      <td>${
                        c.statut === 'OUVERTE' && user.role === 'comptable'
                          ? `<button class="secondary" data-cloturer="${c.id}" data-theorique="${c.montant_theorique}">Clôturer</button>`
                          : ''
                      }</td>
                    </tr>`
                  )
                  .join('')
              : '<tr><td colspan="7" class="empty">Aucune caisse.</td></tr>'
          }
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Commandes prêtes à livrer</h2>
      <p class="desc">Ces commandes ont le statut PREPAREE : assignez-les à un livreur pour la tournée du jour.</p>
      <table>
        <thead><tr><th>N°</th><th>Client</th><th>Montant</th><th>Assigner à</th><th></th></tr></thead>
        <tbody>
          ${
            commandesPreparees.length
              ? commandesPreparees
                  .map(
                    (c) => `<tr>
                      <td>${esc(c.numero_commande)}</td><td>${esc(c.client_nom)}</td><td class="num">${fmt(c.montant_total)} FCFA</td>
                      <td>
                        <select class="select-livreur" data-commande="${c.id}">
                          ${livreurs.map((l) => `<option value="${l.id}">${esc(l.nom_complet)}</option>`).join('')}
                        </select>
                      </td>
                      <td><button class="secondary" data-assign="${c.id}">Assigner</button></td>
                    </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="empty">Aucune commande en attente de livraison.</td></tr>'
          }
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Livraisons récentes</h2>
      <p class="desc">Preuve de livraison saisie par le livreur (nom du réceptionnaire, signature...).</p>
      <table>
        <thead><tr><th>Client</th><th>Commande</th><th>Livreur</th><th>Statut</th><th>Preuve de livraison</th></tr></thead>
        <tbody>
          ${
            livraisons.length
              ? livraisons
                  .map(
                    (l) => `<tr>
                      <td>${esc(l.client_nom)}</td>
                      <td>${esc(l.numero_commande)}</td>
                      <td>${esc(l.livreur_nom) || '-'}</td>
                      <td>${statutLivraisonBadge(l.statut)}</td>
                      <td>${l.preuve_livraison ? esc(l.preuve_livraison) : '<span class="badge muted">non renseignée</span>'}</td>
                    </tr>`
                  )
                  .join('')
              : '<tr><td colspan="5" class="empty">Aucune livraison.</td></tr>'
          }
        </tbody>
      </table>
    </div>
  `;

  container.querySelectorAll('button[data-assign]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const commandeId = btn.dataset.assign;
      const livreurId = container.querySelector(`.select-livreur[data-commande="${commandeId}"]`).value;
      try {
        await Api.post('/logistique/livraisons', {
          commande_id: Number(commandeId),
          livreur_id: Number(livreurId),
          date_prevue: new Date().toISOString().slice(0, 10),
        });
        showToast('Livraison assignée.', 'success');
        window.Views.logistique.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  container.querySelectorAll('button[data-cloturer]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const values = await Modal.open('Clôturer la caisse', [
        { name: 'depose', label: 'Montant réellement déposé (FCFA)', type: 'number', value: btn.dataset.theorique },
      ]);
      if (!values) return;
      try {
        await Api.put(`/logistique/caisse/${btn.dataset.cloturer}/cloturer`, { montant_depose: Number(values.depose) });
        showToast('Caisse clôturée.', 'success');
        window.Views.logistique.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

function statutLivraisonBadge(statut) {
  const map = { A_FAIRE: 'warn', EN_COURS: 'info', TERMINEE: 'ok', ECHOUEE: 'danger' };
  return `<span class="badge ${map[statut] || 'muted'}">${statut.replace('_', ' ')}</span>`;
}

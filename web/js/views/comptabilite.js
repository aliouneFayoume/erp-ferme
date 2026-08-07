window.Views = window.Views || {};

const CATEGORIES_DEPENSE = ['Aliment', 'Intrants', "Main d'œuvre", 'Vétérinaire', 'Logistique', 'Autre'];

// -------------------- Import de relevé bancaire (CSV) --------------------
// Parseur CSV générique (guillemets, séparateur virgule ou point-virgule) : les exports bancaires
// utilisent l'un ou l'autre selon la banque, et peuvent quoter les libellés contenant des virgules.
function parseCsv(texte) {
  const s = texte.replace(/\r\n/g, '\n').replace(/^﻿/, ''); // retire un éventuel BOM UTF-8
  const premiereLigne = s.split('\n', 1)[0] || '';
  const delimiteur = (premiereLigne.match(/;/g) || []).length > (premiereLigne.match(/,/g) || []).length ? ';' : ',';

  const lignes = [];
  let ligne = [];
  let champ = '';
  let dansGuillemets = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          champ += '"';
          i++;
        } else {
          dansGuillemets = false;
        }
      } else {
        champ += c;
      }
    } else if (c === '"') {
      dansGuillemets = true;
    } else if (c === delimiteur) {
      ligne.push(champ);
      champ = '';
    } else if (c === '\n') {
      ligne.push(champ);
      lignes.push(ligne);
      ligne = [];
      champ = '';
    } else {
      champ += c;
    }
  }
  if (champ !== '' || ligne.length) {
    ligne.push(champ);
    lignes.push(ligne);
  }
  return lignes.filter((l) => l.some((c) => c.trim() !== ''));
}

function normaliserDateCsv(valeur) {
  const v = (valeur || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function normaliserMontantCsv(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return null;
  const v = String(valeur)
    .trim()
    .replace(/\s| /g, '')
    .replace(/,/g, '.');
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ROLES_COLONNE = {
  ignorer: 'Ignorer',
  date: 'Date',
  libelle: 'Libellé',
  debit: 'Débit',
  credit: 'Crédit',
  montant: 'Montant',
  sens: 'Sens (crédit/débit)',
};

/** Devine un rôle plausible pour chaque colonne à partir de son en-tête, pour préremplir le mapping. */
function deviner(entete) {
  const e = (entete || '').toLowerCase();
  if (/date/.test(e)) return 'date';
  if (/libell|intitul|description|objet/.test(e)) return 'libelle';
  if (/d[ée]bit/.test(e)) return 'debit';
  if (/cr[ée]dit/.test(e)) return 'credit';
  if (/montant|amount/.test(e)) return 'montant';
  if (/sens|type/.test(e)) return 'sens';
  return 'ignorer';
}

window.Views.comptabilite = {
  async render(container) {
    const [analytique, depenses, secteurs, releves, paiements] = await Promise.all([
      Api.get('/comptabilite/analytique'),
      Api.get('/comptabilite/depenses'),
      Api.get('/production/secteurs'),
      Api.get('/comptabilite/releves-bancaires'),
      Api.get('/finance/paiements'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Comptabilité analytique par pôle</h2>
        <p class="desc">Marge = chiffre d'affaires (commandes livrées ou en cours) − dépenses rattachées au pôle.</p>
        <table>
          <thead><tr><th>Pôle</th><th>Chiffre d'affaires</th><th>Dépenses</th><th>Marge</th></tr></thead>
          <tbody>
            ${analytique.parPole
              .map(
                (p) => `<tr>
                  <td>${esc(p.secteur_nom)}</td>
                  <td class="num">${fmt(p.chiffreAffaires)} FCFA</td>
                  <td class="num">${fmt(p.depenses)} FCFA</td>
                  <td class="num"><b class="${p.marge >= 0 ? 'text-success' : ''}" style="color:${p.marge >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(p.marge)} FCFA</b></td>
                </tr>`
              )
              .join('')}
            <tr>
              <td>Général (non rattaché)</td>
              <td class="num">-</td>
              <td class="num">${fmt(analytique.depensesGenerales)} FCFA</td>
              <td class="num">-</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Nouvelle dépense</h2>
        <form id="form-depense" class="form-grid">
          <label>Pôle (optionnel)
            <select name="secteur_id">
              <option value="">Général</option>
              ${secteurs.map((s) => `<option value="${s.id}">${s.nom}</option>`).join('')}
            </select>
          </label>
          <label>Catégorie
            <select name="categorie">${CATEGORIES_DEPENSE.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </label>
          <label>Montant (FCFA)<input type="number" name="montant" required /></label>
          <label>Date<input type="date" name="date_depense" required value="${new Date().toISOString().slice(0, 10)}" /></label>
          <label>Description<input type="text" name="description" /></label>
          <button type="submit">Enregistrer</button>
        </form>
        <table style="margin-top:16px">
          <thead><tr><th>Date</th><th>Pôle</th><th>Catégorie</th><th>Montant</th><th>Description</th><th></th></tr></thead>
          <tbody>
            ${
              depenses.length
                ? depenses
                    .map(
                      (d) => `<tr>
                        <td>${fmtDate(d.date_depense)}</td>
                        <td>${esc(d.secteur_nom) || 'Général'}</td>
                        <td>${esc(d.categorie)}</td>
                        <td class="num">${fmt(d.montant)} FCFA</td>
                        <td>${esc(d.description) || ''}</td>
                        <td><button class="secondary" data-del-depense="${d.id}">Supprimer</button></td>
                      </tr>`
                    )
                    .join('')
                : '<tr><td colspan="6" class="empty">Aucune dépense.</td></tr>'
            }
          </tbody>
        </table>
      </div>

      <div class="panel">
        <h2>Rapprochement bancaire</h2>
        <p class="desc">Importez un relevé exporté de votre banque (CSV), ou ajoutez une opération manuellement.</p>
        <div class="panel-row">
          <input type="file" id="input-import-releve" accept=".csv,text/csv" style="display:none" />
          <button id="btn-choisir-fichier">Importer un relevé (CSV)</button>
        </div>
        <div class="panel hidden" id="import-preview-panel" style="margin-top:14px"></div>

        <form id="form-releve" class="form-grid" style="margin-top:16px">
          <label>Date<input type="date" name="date_operation" required value="${new Date().toISOString().slice(0, 10)}" /></label>
          <label>Libellé<input type="text" name="libelle" required placeholder="ex: VIR WAVE CLIENT X" /></label>
          <label>Montant (FCFA)<input type="number" name="montant" required /></label>
          <label>Type
            <select name="type_operation"><option value="CREDIT">Crédit (entrée)</option><option value="DEBIT">Débit (sortie)</option></select>
          </label>
          <button type="submit">Ajouter l'opération</button>
        </form>
        <table style="margin-top:16px">
          <thead><tr><th>Date</th><th>Libellé</th><th>Montant</th><th>Type</th><th>Statut</th><th></th></tr></thead>
          <tbody id="releves-body"></tbody>
        </table>
      </div>
    `;

    renderReleves(container, releves, paiements);

    container.querySelector('#form-depense').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/comptabilite/depenses', {
          secteur_id: fd.get('secteur_id') ? Number(fd.get('secteur_id')) : null,
          categorie: fd.get('categorie'),
          montant: Number(fd.get('montant')),
          description: fd.get('description') || null,
          date_depense: fd.get('date_depense'),
        });
        showToast('Dépense enregistrée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-del-depense]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await Api.del(`/comptabilite/depenses/${btn.dataset.delDepense}`);
          showToast('Dépense supprimée.', 'success');
          window.Views.comptabilite.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelector('#form-releve').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/comptabilite/releves-bancaires', {
          date_operation: fd.get('date_operation'),
          libelle: fd.get('libelle'),
          montant: Number(fd.get('montant')),
          type_operation: fd.get('type_operation'),
        });
        showToast('Opération ajoutée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#btn-choisir-fichier').addEventListener('click', () => {
      container.querySelector('#input-import-releve').click();
    });
    container.querySelector('#input-import-releve').addEventListener('change', async (e) => {
      const fichier = e.target.files && e.target.files[0];
      if (!fichier) return;
      const texte = await fichier.text();
      const lignes = parseCsv(texte);
      e.target.value = '';
      if (lignes.length < 2) {
        showToast('Fichier vide ou illisible.', 'error');
        return;
      }
      afficherApercuImport(container, lignes);
    });
  },
};

/** Affiche l'aperçu + le mapping de colonnes pour un CSV chargé, avant import effectif. */
function afficherApercuImport(container, lignes) {
  const [entetes, ...donnees] = lignes;
  const roles = entetes.map((e) => deviner(e));
  const panel = container.querySelector('#import-preview-panel');
  panel.classList.remove('hidden');

  const rendreTable = () => `
    <p class="desc">Indiquez à quoi correspond chaque colonne, puis vérifiez l'aperçu avant d'importer.</p>
    <table>
      <thead><tr>${entetes
        .map(
          (e, i) => `<th>
            ${esc(e) || `Colonne ${i + 1}`}<br/>
            <select class="select-role-colonne" data-col="${i}" style="margin-top:4px;font-weight:400">
              ${Object.entries(ROLES_COLONNE)
                .map(([val, label]) => `<option value="${val}" ${roles[i] === val ? 'selected' : ''}>${label}</option>`)
                .join('')}
            </select>
          </th>`
        )
        .join('')}</tr></thead>
      <tbody>
        ${donnees
          .slice(0, 5)
          .map((l) => `<tr>${entetes.map((_, i) => `<td>${esc(l[i] ?? '')}</td>`).join('')}</tr>`)
          .join('')}
      </tbody>
    </table>
    <p class="desc">${donnees.length} ligne(s) au total dans le fichier.</p>
    <div class="panel-row">
      <button class="secondary" id="btn-annuler-import">Annuler</button>
      <button id="btn-confirmer-import">Importer</button>
    </div>
    <div id="import-erreurs"></div>
  `;

  panel.innerHTML = rendreTable();

  panel.querySelectorAll('.select-role-colonne').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      roles[Number(e.target.dataset.col)] = e.target.value;
    });
  });

  panel.querySelector('#btn-annuler-import').addEventListener('click', () => {
    panel.classList.add('hidden');
    panel.innerHTML = '';
  });

  panel.querySelector('#btn-confirmer-import').addEventListener('click', async () => {
    const erreursDiv = panel.querySelector('#import-erreurs');
    erreursDiv.innerHTML = '';

    const iDate = roles.indexOf('date');
    const iLibelle = roles.indexOf('libelle');
    const iDebit = roles.indexOf('debit');
    const iCredit = roles.indexOf('credit');
    const iMontant = roles.indexOf('montant');
    const iSens = roles.indexOf('sens');

    if (iDate === -1 || iLibelle === -1) {
      erreursDiv.innerHTML = '<p class="login-error">Il faut au moins une colonne Date et une colonne Libellé.</p>';
      return;
    }
    const modeDebitCredit = iDebit !== -1 || iCredit !== -1;
    const modeMontantSens = iMontant !== -1 && iSens !== -1;
    if (!modeDebitCredit && !modeMontantSens) {
      erreursDiv.innerHTML =
        '<p class="login-error">Indiquez soit des colonnes Débit/Crédit, soit des colonnes Montant + Sens.</p>';
      return;
    }

    const lignesNormalisees = [];
    const erreursParsing = [];
    donnees.forEach((l, idx) => {
      const date_operation = normaliserDateCsv(l[iDate]);
      const libelle = (l[iLibelle] || '').trim();
      let montant = null;
      let type_operation = null;

      if (modeDebitCredit) {
        const debit = iDebit !== -1 ? normaliserMontantCsv(l[iDebit]) : null;
        const credit = iCredit !== -1 ? normaliserMontantCsv(l[iCredit]) : null;
        if (credit && credit > 0) {
          montant = credit;
          type_operation = 'CREDIT';
        } else if (debit && debit > 0) {
          montant = Math.abs(debit);
          type_operation = 'DEBIT';
        }
      } else {
        const m = normaliserMontantCsv(l[iMontant]);
        const sens = (l[iSens] || '').trim().toLowerCase();
        if (m !== null) {
          montant = Math.abs(m);
          type_operation = m < 0 || sens.startsWith('d') ? 'DEBIT' : 'CREDIT';
        }
      }

      if (!date_operation || !libelle || montant === null || !type_operation) {
        erreursParsing.push(idx + 2); // +2 : ligne 1 = en-têtes, index 0-based
        return;
      }
      lignesNormalisees.push({ date_operation, libelle, montant, type_operation });
    });

    if (lignesNormalisees.length === 0) {
      erreursDiv.innerHTML = '<p class="login-error">Aucune ligne exploitable avec ce mapping — vérifiez les colonnes choisies.</p>';
      return;
    }

    try {
      const resultat = await Api.post('/comptabilite/releves-bancaires/import', { lignes: lignesNormalisees });
      const totalIgnorees = erreursParsing.length + resultat.rejetees.length;
      showToast(
        `${resultat.inserees} opération(s) importée(s).${totalIgnorees ? ` ${totalIgnorees} ligne(s) ignorée(s) (format illisible).` : ''}`,
        'success'
      );
      panel.classList.add('hidden');
      panel.innerHTML = '';
      window.Views.comptabilite.render(container);
    } catch (err) {
      erreursDiv.innerHTML = `<p class="login-error">${esc(err.message)}</p>`;
    }
  });
}

function renderReleves(container, releves, paiements) {
  const body = container.querySelector('#releves-body');
  const paiementsDejaRapproches = new Set(releves.filter((r) => r.paiement_id).map((r) => r.paiement_id));
  const paiementsDisponibles = paiements.filter((p) => p.statut === 'VALIDE' && !paiementsDejaRapproches.has(p.id));

  body.innerHTML = releves.length
    ? releves
        .map(
          (r) => `<tr>
            <td>${fmtDate(r.date_operation)}</td>
            <td>${esc(r.libelle)}</td>
            <td class="num">${fmt(r.montant)} FCFA</td>
            <td><span class="badge ${r.type_operation === 'CREDIT' ? 'ok' : 'muted'}">${esc(r.type_operation)}</span></td>
            <td>${
              r.rapproche
                ? `<span class="badge ok">Rapproché${r.client_nom ? ` — ${esc(r.client_nom)}` : ''}</span>`
                : r.suggestion
                ? `<span class="badge info">Suggéré : ${esc(r.suggestion.client_nom) || 'paiement'} (${esc(r.suggestion.methode_paiement)})</span>`
                : `<span class="badge warn">En attente</span>`
            }</td>
            <td>
              ${
                r.rapproche
                  ? `<button class="secondary" data-annuler="${r.id}">Annuler</button>`
                  : `<select class="select-paiement" data-releve="${r.id}">
                      <option value="">— choisir un paiement —</option>
                      ${paiementsDisponibles
                        .map(
                          (p) =>
                            `<option value="${p.id}" ${r.suggestion && r.suggestion.id === p.id ? 'selected' : ''}>${esc(p.client_nom)} — ${fmt(p.montant)} FCFA (${esc(p.methode_paiement)})</option>`
                        )
                        .join('')}
                    </select>
                    <button class="secondary" data-rapprocher="${r.id}">Rapprocher</button>`
              }
            </td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">Aucune opération.</td></tr>';

  body.querySelectorAll('button[data-rapprocher]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const select = body.querySelector(`.select-paiement[data-releve="${btn.dataset.rapprocher}"]`);
      if (!select.value) {
        showToast('Sélectionnez un paiement à rapprocher.', 'error');
        return;
      }
      try {
        await Api.put(`/comptabilite/releves-bancaires/${btn.dataset.rapprocher}/rapprocher`, { paiement_id: Number(select.value) });
        showToast('Opération rapprochée.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  body.querySelectorAll('button[data-annuler]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await Api.put(`/comptabilite/releves-bancaires/${btn.dataset.annuler}/annuler-rapprochement`, {});
        showToast('Rapprochement annulé.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

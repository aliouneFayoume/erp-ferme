window.Views = window.Views || {};

const CATEGORIES_DEPENSE = ['Intrants', "Main d'œuvre", 'Machines & Équipements', 'Eau & Électricité', 'Récolte & Post-récolte', 'Autre'];

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
    .replace(/\s| /g, '')
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

function etatBadge(etat) {
  const map = { Bon: 'ok', 'A réparer': 'warn', 'Hors service': 'danger' };
  return `<span class="badge ${map[etat] || 'muted'}">${etat}</span>`;
}

function moisCourant() {
  return new Date().toISOString().slice(0, 7);
}

window.Views.comptabilite = {
  async render(container) {
    const [analytique, depenses, secteurs, releves, paiements, equipements, fournisseurs] = await Promise.all([
      Api.get('/comptabilite/analytique'),
      Api.get('/comptabilite/depenses'),
      Api.get('/production/secteurs'),
      Api.get('/comptabilite/releves-bancaires'),
      Api.get('/finance/paiements'),
      Api.get('/immobilisations'),
      Api.get('/fournisseurs'),
    ]);
    const moi = Api.getUser();
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const enRetardEntretien = equipements.filter((e) => e.prochain_entretien && e.prochain_entretien.slice(0, 10) < aujourdhui);

    // Colonnes du pivot "coûts par catégorie" : chaque pôle + une colonne "Général" (dépenses non
    // rattachées à un secteur), et une ligne par catégorie de la taxonomie + toute catégorie
    // historique encore présente en base (ex: anciennes valeurs "Aliment"/"Vétérinaire").
    const colonnesPole = [...analytique.parPole, { secteur_id: 'general', secteur_nom: 'Général', parCategorie: analytique.depensesGeneralesParCategorie }];
    const categoriesPresentes = new Set(CATEGORIES_DEPENSE);
    colonnesPole.forEach((p) => Object.keys(p.parCategorie || {}).forEach((c) => categoriesPresentes.add(c)));

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
                  <td class="num"><b style="color:${p.marge >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(p.marge)} FCFA</b></td>
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
        <h2>Répartition des coûts par catégorie</h2>
        <p class="desc">D'où vient la dépense de chaque pôle — intrants, main d'œuvre, machines, eau/électricité, récolte...</p>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>Catégorie</th>${colonnesPole.map((p) => `<th class="num">${esc(p.secteur_nom)}</th>`).join('')}</tr></thead>
            <tbody>
              ${[...categoriesPresentes]
                .map(
                  (cat) => `<tr>
                    <td>${esc(cat)}</td>
                    ${colonnesPole.map((p) => `<td class="num">${fmt((p.parCategorie || {})[cat] || 0)} FCFA</td>`).join('')}
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <h2>Nouvelle dépense</h2>
        <form id="form-depense" class="form-grid">
          <label>Pôle (optionnel)
            <select name="secteur_id">
              <option value="">Général</option>
              ${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Catégorie
            <select name="categorie">${CATEGORIES_DEPENSE.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
          </label>
          <label>Montant (FCFA)<input type="number" name="montant" required /></label>
          <label>Date<input type="date" name="date_depense" required value="${aujourdhui}" /></label>
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

      ${
        enRetardEntretien.length
          ? `<div class="panel alert-panel">
              <h2>⚠ Entretiens en retard</h2>
              <ul class="alert-list">
                ${enRetardEntretien.map((e) => `<li>${esc(e.nom)} — entretien prévu le ${fmtDate(e.prochain_entretien)}</li>`).join('')}
              </ul>
            </div>`
          : ''
      }

      <div class="panel">
        <h2>Immobilisations</h2>
        <p class="desc">Matériel de la ferme : inventaire, entretien, et amortissement des équipements achetés.</p>
        <form id="form-equipement" class="form-grid">
          <label>Nom<input type="text" name="nom" required /></label>
          <label>Catégorie
            <select name="categorie">
              <option value="Motoculture">Motoculture</option>
              <option value="Irrigation">Irrigation</option>
              <option value="Transport">Transport</option>
              <option value="Avicole">Avicole</option>
              <option value="Piscicole">Piscicole</option>
              <option value="Autre">Autre</option>
            </select>
          </label>
          <label>Secteur (optionnel)
            <select name="secteur_id">
              <option value="">— Partagé / non rattaché —</option>
              ${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Fournisseur (optionnel)
            <select name="fournisseur_id">
              <option value="">— Inconnu —</option>
              ${fournisseurs.map((f) => `<option value="${f.id}">${esc(f.nom)}</option>`).join('')}
            </select>
          </label>
          <label>Quantité<input type="number" name="quantite" min="1" value="1" /></label>
          <label>Date d'achat<input type="date" name="date_achat" /></label>
          <label>Valeur d'achat (FCFA)<input type="number" name="valeur_achat" min="0" step="0.01" /></label>
          <label>Durée d'amortissement (mois, optionnel)<input type="number" name="duree_amortissement_mois" min="1" /></label>
          <label>Valeur résiduelle (FCFA, optionnel)<input type="number" name="valeur_residuelle" min="0" step="0.01" value="0" /></label>
          <label>Notes<input type="text" name="notes" /></label>
          <button type="submit">Ajouter l'équipement</button>
        </form>

        <table style="margin-top:16px">
          <thead><tr><th>Nom</th><th>Catégorie</th><th>Secteur</th><th>État</th><th>Valeur nette</th><th>Prochain entretien</th><th></th></tr></thead>
          <tbody>
            ${equipements
              .map((e) => {
                const retard = e.prochain_entretien && e.prochain_entretien.slice(0, 10) < aujourdhui;
                return `<tr>
                  <td>${esc(e.nom)}</td>
                  <td>${esc(e.categorie) || '-'}</td>
                  <td>${esc(e.secteur_nom) || '-'}</td>
                  <td>${etatBadge(e.etat)}</td>
                  <td class="num">${e.valeur_nette_comptable != null ? `${fmt(e.valeur_nette_comptable)} FCFA` : '-'}</td>
                  <td>${e.prochain_entretien ? `<span class="badge ${retard ? 'danger' : 'ok'}">${fmtDate(e.prochain_entretien)}</span>` : '-'}</td>
                  <td class="actions-cell">
                    <button class="secondary" data-modifier="${e.id}">Modifier</button>
                    <button class="secondary" data-entretien="${e.id}">Entretien</button>
                    <button class="secondary" data-historique="${e.id}">Historique</button>
                    ${moi.role === 'admin' ? `<button class="danger" data-supprimer="${e.id}">Supprimer</button>` : ''}
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
        ${equipements.length === 0 ? '<p class="empty">Aucun équipement enregistré.</p>' : ''}

        <div style="margin-top:16px;display:flex;gap:8px;align-items:end;flex-wrap:wrap">
          <label>Mois à comptabiliser<input type="month" id="mois-amortissement" value="${moisCourant()}" /></label>
          <button type="button" id="btn-calculer-amortissements">Calculer les amortissements du mois</button>
        </div>
        <p class="desc">Passe la dotation d'amortissement du mois en dépense pour chaque équipement ayant une durée d'amortissement renseignée. Sans effet si déjà comptabilisé pour ce mois.</p>

        <div id="historique-zone" style="margin-top:16px"><p class="empty">Cliquez sur "Historique" pour un équipement ci-dessus.</p></div>
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
          <label>Date<input type="date" name="date_operation" required value="${aujourdhui}" /></label>
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

    // -------------------- Dépenses --------------------

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

    // -------------------- Immobilisations --------------------

    container.querySelector('#form-equipement').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/immobilisations', {
          nom: fd.get('nom'),
          categorie: fd.get('categorie'),
          secteur_id: fd.get('secteur_id') || null,
          fournisseur_id: fd.get('fournisseur_id') || null,
          quantite: Number(fd.get('quantite')) || 1,
          date_achat: fd.get('date_achat') || null,
          valeur_achat: fd.get('valeur_achat') || null,
          duree_amortissement_mois: fd.get('duree_amortissement_mois') || null,
          valeur_residuelle: fd.get('valeur_residuelle') || 0,
          notes: fd.get('notes'),
        });
        showToast('Équipement ajouté.', 'success');
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-modifier]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.modifier));
        const values = await Modal.open(`Modifier ${eq.nom}`, [
          { name: 'nom', label: 'Nom', type: 'text', value: eq.nom },
          { name: 'categorie', label: 'Catégorie', type: 'text', value: eq.categorie || '' },
          {
            name: 'etat', label: 'État', type: 'select', value: eq.etat,
            options: ['Bon', 'A réparer', 'Hors service'].map((v) => ({ value: v, label: v })),
          },
          { name: 'quantite', label: 'Quantité', type: 'number', value: eq.quantite },
          { name: 'duree_amortissement_mois', label: "Durée d'amortissement (mois)", type: 'number', value: eq.duree_amortissement_mois || '' },
          { name: 'valeur_residuelle', label: 'Valeur résiduelle (FCFA)', type: 'number', value: eq.valeur_residuelle || 0 },
          { name: 'notes', label: 'Notes', type: 'text', value: eq.notes || '' },
        ]);
        if (!values) return;
        try {
          await Api.put(`/immobilisations/${eq.id}`, {
            ...values,
            quantite: Number(values.quantite) || eq.quantite,
            duree_amortissement_mois: values.duree_amortissement_mois ? Number(values.duree_amortissement_mois) : null,
            valeur_residuelle: values.valeur_residuelle !== '' ? Number(values.valeur_residuelle) : 0,
          });
          showToast('Équipement mis à jour.', 'success');
          window.Views.comptabilite.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-entretien]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.entretien));
        const values = await Modal.open(`Nouvel entretien — ${eq.nom}`, [
          { name: 'date_entretien', label: "Date de l'entretien", type: 'date', value: aujourdhui },
          { name: 'description', label: 'Description', type: 'text', value: '' },
          { name: 'cout', label: 'Coût (FCFA, optionnel — génère une dépense)', type: 'number', value: '' },
          { name: 'prochain_entretien', label: 'Prochain entretien prévu (optionnel)', type: 'date', value: '' },
        ]);
        if (!values || !values.date_entretien) return;
        try {
          await Api.post(`/immobilisations/${eq.id}/entretiens`, {
            date_entretien: values.date_entretien,
            description: values.description,
            cout: values.cout || null,
            prochain_entretien: values.prochain_entretien || null,
          });
          showToast(values.cout ? 'Entretien enregistré et dépense créée.' : 'Entretien enregistré.', 'success');
          window.Views.comptabilite.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-historique]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.historique));
        const zone = container.querySelector('#historique-zone');
        zone.innerHTML = '<div class="empty">Chargement…</div>';
        try {
          const entretiens = await Api.get(`/immobilisations/${eq.id}/entretiens`);
          zone.innerHTML = `
            <h3>Historique — ${esc(eq.nom)}</h3>
            ${
              entretiens.length === 0
                ? '<p class="empty">Aucun entretien enregistré.</p>'
                : `<table>
                    <thead><tr><th>Date</th><th>Description</th><th>Coût</th><th>Prochain entretien</th></tr></thead>
                    <tbody>
                      ${entretiens
                        .map(
                          (h) => `<tr>
                            <td>${fmtDate(h.date_entretien)}</td>
                            <td>${esc(h.description) || '-'}</td>
                            <td class="num">${h.cout ? `${fmt(h.cout)} FCFA` : '-'}</td>
                            <td>${fmtDate(h.prochain_entretien)}</td>
                          </tr>`
                        )
                        .join('')}
                    </tbody>
                  </table>`
            }
          `;
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const eq = equipements.find((x) => x.id === Number(btn.dataset.supprimer));
        const values = await Modal.open(`Supprimer ${eq.nom} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/immobilisations/${eq.id}`);
          showToast('Équipement supprimé.', 'success');
          window.Views.comptabilite.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelector('#btn-calculer-amortissements').addEventListener('click', async () => {
      const mois = container.querySelector('#mois-amortissement').value;
      if (!mois) return;
      try {
        const resultat = await Api.post('/immobilisations/amortissements/calculer', { periode: `${mois}-01` });
        showToast(
          resultat.comptabilises > 0
            ? `${resultat.comptabilises} amortissement(s) comptabilisé(s) pour ${mois}.`
            : `Aucun nouvel amortissement à comptabiliser pour ${mois} (déjà fait, ou aucun équipement amortissable).`,
          'success'
        );
        window.Views.comptabilite.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // -------------------- Rapprochement bancaire --------------------

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

window.Views = window.Views || {};

const ROLE_LABEL = { admin: 'Super-Administrateur', comptable: 'Comptable', chef_prod: 'Chef de production', livreur: 'Livreur' };

window.Views.utilisateurs = {
  async render(container) {
    const moi = Api.getUser();
    const [utilisateurs, roles, secteurs] = await Promise.all([
      Api.get('/utilisateurs'),
      Api.get('/utilisateurs/roles'),
      Api.get('/production/secteurs'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Nouvel utilisateur</h2>
        <form id="form-user" class="form-grid">
          <label>Nom complet<input type="text" name="nom_complet" required /></label>
          <label>Email<input type="email" name="email" required /></label>
          <label>Mot de passe (10 caractères min., avec majuscule, minuscule, chiffre et caractère spécial)<input type="password" name="password" required minlength="10" /></label>
          <label>Rôle
            <select name="role" id="select-role-new" required>
              ${roles.map((r) => `<option value="${r.nom}">${esc(ROLE_LABEL[r.nom] || r.nom)}</option>`).join('')}
            </select>
          </label>
          <label id="champ-secteur-new" class="hidden">Secteur (Chef de production)
            <select name="secteur_id">${secteurs.map((s) => `<option value="${s.id}">${esc(s.nom)}</option>`).join('')}</select>
          </label>
          <button type="submit">Créer l'utilisateur</button>
        </form>
      </div>

      <div class="panel">
        <h2>Utilisateurs (${utilisateurs.length})</h2>
        <table>
          <thead><tr><th>Nom</th><th>Email</th><th>Rôle</th><th>Secteur</th><th>Statut</th><th></th></tr></thead>
          <tbody>
            ${utilisateurs
              .map((u) => {
                const secteurNom = secteurs.find((s) => s.id === u.secteur_id)?.nom;
                return `<tr>
                  <td>${esc(u.nom_complet)}${u.id === moi.id ? ' <span class="badge info">vous</span>' : ''}</td>
                  <td>${esc(u.email)}</td>
                  <td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
                  <td>${secteurNom ? esc(secteurNom) : '-'}</td>
                  <td><span class="badge ${u.actif ? 'ok' : 'muted'}">${u.actif ? 'Actif' : 'Inactif'}</span></td>
                  <td style="white-space:nowrap">
                    <button class="secondary" data-modifier="${u.id}">Modifier</button>
                    <button class="secondary" data-mdp="${u.id}">Mot de passe</button>
                    ${u.id !== moi.id ? `<button class="danger" data-supprimer="${u.id}">Supprimer</button>` : ''}
                  </td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    const toggleSecteurChamp = (selectEl, champEl) => {
      champEl.classList.toggle('hidden', selectEl.value !== 'chef_prod');
    };
    const selectRoleNew = container.querySelector('#select-role-new');
    const champSecteurNew = container.querySelector('#champ-secteur-new');
    toggleSecteurChamp(selectRoleNew, champSecteurNew);
    selectRoleNew.addEventListener('change', () => toggleSecteurChamp(selectRoleNew, champSecteurNew));

    container.querySelector('#form-user').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.post('/utilisateurs', {
          nom_complet: fd.get('nom_complet'),
          email: fd.get('email'),
          password: fd.get('password'),
          role: fd.get('role'),
          secteur_id: fd.get('secteur_id') ? Number(fd.get('secteur_id')) : null,
        });
        showToast('Utilisateur créé.', 'success');
        window.Views.utilisateurs.render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelectorAll('button[data-modifier]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const u = utilisateurs.find((x) => x.id === Number(btn.dataset.modifier));
        const values = await Modal.open(`Modifier ${u.nom_complet}`, [
          { name: 'nom_complet', label: 'Nom complet', type: 'text', value: u.nom_complet },
          { name: 'email', label: 'Email', type: 'email', value: u.email },
          { name: 'role', label: 'Rôle', type: 'select', value: u.role, options: roles.map((r) => ({ value: r.nom, label: ROLE_LABEL[r.nom] || r.nom })) },
          { name: 'secteur_id', label: 'Secteur (si Chef de production)', type: 'select', value: u.secteur_id ?? '', options: [{ value: '', label: '—' }, ...secteurs.map((s) => ({ value: s.id, label: s.nom }))] },
          { name: 'actif', label: 'Statut', type: 'select', value: String(u.actif), options: [{ value: 'true', label: 'Actif' }, { value: 'false', label: 'Inactif' }] },
        ]);
        if (!values) return;
        try {
          await Api.put(`/utilisateurs/${u.id}`, {
            nom_complet: values.nom_complet,
            email: values.email,
            role: values.role,
            secteur_id: values.secteur_id ? Number(values.secteur_id) : null,
            actif: values.actif === 'true',
          });
          showToast('Utilisateur mis à jour.', 'success');
          window.Views.utilisateurs.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-mdp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const values = await Modal.open('Changer le mot de passe', [
          { name: 'password', label: 'Nouveau mot de passe (10 caractères min., majuscule/minuscule/chiffre/caractère spécial)', type: 'password', value: '' },
        ]);
        if (!values) return;
        try {
          await Api.put(`/utilisateurs/${btn.dataset.mdp}/mot-de-passe`, { password: values.password });
          showToast('Mot de passe mis à jour.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('button[data-supprimer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const u = utilisateurs.find((x) => x.id === Number(btn.dataset.supprimer));
        const values = await Modal.open(`Supprimer ${u.nom_complet} ?`, [
          { name: 'confirmer', label: 'Tapez "OUI" pour confirmer', type: 'text', value: '' },
        ]);
        if (!values || values.confirmer.trim().toUpperCase() !== 'OUI') return;
        try {
          await Api.del(`/utilisateurs/${btn.dataset.supprimer}`);
          showToast('Utilisateur supprimé.', 'success');
          window.Views.utilisateurs.render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  },
};

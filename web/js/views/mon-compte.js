window.Views = window.Views || {};

const MFA_METHODE_LABEL = { TOTP: "Application d'authentification", WHATSAPP: 'WhatsApp' };

window.Views['mon-compte'] = {
  async render(container) {
    const { utilisateur } = await Api.get('/auth/me');

    // Compte d'essai autonome : ouvert avec un simple numéro WhatsApp, sans e-mail ni mot de passe. Tant qu'il n'est pas
    // sécurisé, la carte « Mot de passe » n'aurait aucun sens (il n'y en a pas) : on propose d'en créer un.
    const carteIdentifiants = utilisateur.compteSecurise
      ? `<div class="panel">
        <h2>Mot de passe</h2>
        <form id="form-mdp" class="form-grid" autocomplete="off">
          <label>Mot de passe actuel<input type="password" name="currentPassword" required autocomplete="current-password" /></label>
          <label>Nouveau mot de passe (10 caractères min., avec majuscule, minuscule, chiffre et caractère spécial)
            <input type="password" name="newPassword" required minlength="10" autocomplete="new-password" />
          </label>
          <button type="submit">Mettre à jour le mot de passe</button>
        </form>
      </div>`
      : `<div class="panel">
        <h2>Sécuriser mon compte</h2>
        ${
          utilisateur.emailEnAttente
            ? `<p><span class="badge warn">E-mail à confirmer</span> Un lien a été envoyé à <strong>${esc(utilisateur.email)}</strong>. Cliquez dessus pour terminer. Une faute de frappe ? Corrigez l'adresse ci-dessous.</p>`
            : `<p class="sub">Aujourd'hui vous vous connectez avec un code reçu sur WhatsApp${utilisateur.telephone ? ` (${esc(utilisateur.telephone)})` : ''}. Ajoutez une adresse e-mail et un mot de passe : vous pourrez aussi vous connecter ainsi, et c'est nécessaire avant de passer en Pro (équipe, double authentification). Le code WhatsApp reste utilisable.</p>`
        }
        <form id="form-securiser" class="form-grid" autocomplete="off">
          <label>Adresse e-mail<input type="email" name="email" required maxlength="100" autocomplete="email" value="${esc(utilisateur.email || '')}" /></label>
          <label>Mot de passe (10 caractères min., avec majuscule, minuscule, chiffre et caractère spécial)
            <input type="password" name="password" required minlength="10" autocomplete="new-password" />
          </label>
          <button type="submit">${utilisateur.emailEnAttente ? "Renvoyer le lien" : 'Sécuriser mon compte'}</button>
        </form>
      </div>`;

    container.innerHTML = `
      ${carteIdentifiants}

      <div class="panel">
        <h2>Authentification à deux facteurs (MFA)</h2>
        ${
          utilisateur.mfaObligatoire && !utilisateur.mfaActif
            ? `<p><span class="badge warn">Obligatoire pour votre compte</span> — configurez-la ci-dessous pour continuer à utiliser l'application.</p>`
            : ''
        }
        <p>Statut :
          <span class="badge ${utilisateur.mfaActif ? 'ok' : 'muted'}">
            ${utilisateur.mfaActif ? `Activé (${MFA_METHODE_LABEL[utilisateur.mfaMethode] || utilisateur.mfaMethode})` : 'Désactivé'}
          </span>
        </p>

        ${
          !utilisateur.compteSecurise
            ? `<p class="sub">Sécurisez d'abord votre compte (carte ci-dessus) : la double authentification se configure avec votre mot de passe.</p>`
            : utilisateur.mfaActif
            ? `<button class="danger" id="btn-mfa-desactiver">Désactiver le MFA</button>`
            : `
          <div class="form-grid">
            <div class="panel-inline">
              <h3>Application d'authentification (TOTP)</h3>
              <p class="sub">Google Authenticator, Authy, ou équivalent.</p>
              <button id="btn-totp-init">Configurer</button>
              <div id="zone-totp" class="hidden"></div>
            </div>
            <div class="panel-inline">
              <h3>Code par WhatsApp</h3>
              <p class="sub"><span class="badge muted">Bientôt disponible</span> — en attente de l'activation du numéro WhatsApp Business. Utilisez l'application d'authentification en attendant.</p>
            </div>
          </div>
        `
        }
      </div>
    `;

    container.querySelector('#form-securiser')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await Api.post('/auth/securiser-compte', { email: fd.get('email'), password: fd.get('password') });
        // Le mot de passe vient d'être posé : la session change de version, l'identité affichée reste la même.
        Api.setSession(data.token, Api.getUser());
        showToast(data.message, 'success');
        window.Views['mon-compte'].render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#form-mdp')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const data = await Api.put('/auth/mot-de-passe', {
          currentPassword: fd.get('currentPassword'),
          newPassword: fd.get('newPassword'),
        });
        // Le token change (token_version incrémenté) mais pas l'identité de l'utilisateur affichée.
        Api.setSession(data.token, Api.getUser());
        showToast('Mot de passe mis à jour.', 'success');
        e.target.reset();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    if (utilisateur.mfaActif) {
      container.querySelector('#btn-mfa-desactiver').addEventListener('click', async () => {
        const values = await Modal.open('Désactiver le MFA', [{ name: 'currentPassword', label: 'Mot de passe actuel', type: 'password', value: '' }]);
        if (!values) return;
        try {
          await Api.del('/auth/mfa', { currentPassword: values.currentPassword });
          showToast('MFA désactivé.', 'success');
          window.Views['mon-compte'].render(container);
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
      return;
    }

    container.querySelector('#btn-totp-init')?.addEventListener('click', async () => {
      // Le serveur exige une reconfirmation du mot de passe pour brancher un nouveau second
      // facteur (audit sécurité 2026-08-27) — un jeton de session seul ne suffit plus.
      const values = await Modal.open('Configurer le MFA', [{ name: 'currentPassword', label: 'Mot de passe actuel', type: 'password', value: '' }]);
      if (!values) return;
      try {
        const data = await Api.post('/auth/mfa/totp/init', { currentPassword: values.currentPassword });
        const zone = container.querySelector('#zone-totp');
        zone.classList.remove('hidden');
        zone.innerHTML = `
          <img src="${data.qrCodeDataUrl}" alt="QR code TOTP" style="max-width:180px; margin-top:8px;" />
          <p class="sub">Ou saisissez manuellement dans votre application : <code>${esc(data.secret)}</code></p>
          <label>Code de confirmation (6 chiffres)<input type="text" id="input-totp-code" inputmode="numeric" maxlength="6" /></label>
          <button id="btn-totp-activer">Activer</button>
        `;
        zone.querySelector('#btn-totp-activer').addEventListener('click', async () => {
          try {
            await Api.post('/auth/mfa/totp/activer', { code: zone.querySelector('#input-totp-code').value });
            showToast('MFA activé.', 'success');
            window.Views['mon-compte'].render(container);
          } catch (err) {
            showToast(err.message, 'error');
          }
        });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

  },
};

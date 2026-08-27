window.Views = window.Views || {};

const MFA_METHODE_LABEL = { TOTP: "Application d'authentification", WHATSAPP: 'WhatsApp' };

window.Views['mon-compte'] = {
  async render(container) {
    const { utilisateur } = await Api.get('/auth/me');

    container.innerHTML = `
      <div class="panel">
        <h2>Mot de passe</h2>
        <form id="form-mdp" class="form-grid">
          <label>Mot de passe actuel<input type="password" name="currentPassword" required autocomplete="current-password" /></label>
          <label>Nouveau mot de passe (10 caractères min., avec majuscule, minuscule, chiffre et caractère spécial)
            <input type="password" name="newPassword" required minlength="10" autocomplete="new-password" />
          </label>
          <button type="submit">Mettre à jour le mot de passe</button>
        </form>
      </div>

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
          utilisateur.mfaActif
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

    container.querySelector('#form-mdp').addEventListener('submit', async (e) => {
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

    container.querySelector('#btn-totp-init').addEventListener('click', async () => {
      try {
        const data = await Api.post('/auth/mfa/totp/init', {});
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

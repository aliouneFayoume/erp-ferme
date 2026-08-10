window.Views = window.Views || {};

window.Views['parametres-paiement'] = {
  async render(container) {
    const [config, configWhatsapp] = await Promise.all([
      Api.get('/parametres-paiement/paiement'),
      Api.get('/parametres-whatsapp'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Agrégateur de paiement (PayDunya)</h2>
        <p class="desc">
          Votre organisation a son propre compte PayDunya, distinct de toute autre ferme utilisant
          cette plateforme. Les identifiants saisis ici servent à encaisser les paiements Mobile
          Money/carte de VOS clients — ils ne sont jamais visibles ni partagés en dehors de votre
          organisation, et ne sont plus jamais réaffichés une fois enregistrés.
        </p>
        <p>
          Statut :
          ${
            config.configure
              ? `<span class="badge ok">Configuré (mode ${esc(config.mode)})</span>`
              : `<span class="badge warn">Non configuré — les paiements PayDunya sont désactivés</span>`
          }
        </p>
        <form id="form-paiement" class="form-grid">
          <label>Mode
            <select name="mode">
              <option value="test" ${config.mode === 'test' || !config.mode ? 'selected' : ''}>Test (sandbox)</option>
              <option value="live" ${config.mode === 'live' ? 'selected' : ''}>Live (production)</option>
            </select>
          </label>
          <label>Master Key<input type="password" name="master_key" autocomplete="off" required /></label>
          <label>Private Key<input type="password" name="private_key" autocomplete="off" required /></label>
          <label>Public Key<input type="password" name="public_key" autocomplete="off" required /></label>
          <label>Token<input type="password" name="token" autocomplete="off" required /></label>
          <button type="submit">${config.configure ? 'Remplacer les identifiants' : 'Enregistrer'}</button>
        </form>
      </div>

      <div class="panel">
        <h2>Relances clients par WhatsApp</h2>
        ${
          configWhatsapp.estPlateforme
            ? `<p class="desc">Ferme Massla utilise déjà son propre compte WhatsApp Business, configuré au niveau de la plateforme — rien à faire ici.</p>`
            : `
        <p class="desc">
          Pour relancer VOS clients par WhatsApp (module Finances), votre organisation doit avoir son
          propre compte WhatsApp Business (Meta) — ce n'est jamais celui de Massla. Créez une app sur
          <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com</a>,
          ajoutez le produit WhatsApp, et renseignez ci-dessous le jeton d'accès et l'ID du numéro de
          téléphone. Jamais réaffichés une fois enregistrés.
        </p>
        <p>
          Statut :
          ${
            configWhatsapp.configure
              ? `<span class="badge ok">Configuré</span>`
              : `<span class="badge warn">Non configuré — les rappels WhatsApp sont désactivés pour vos clients</span>`
          }
        </p>
        <form id="form-whatsapp" class="form-grid">
          <label>Jeton d'accès (Access Token)<input type="password" name="access_token" autocomplete="off" required /></label>
          <label>ID du numéro de téléphone (Phone Number ID)<input type="text" name="phone_number_id" autocomplete="off" required /></label>
          <button type="submit">${configWhatsapp.configure ? 'Remplacer les identifiants' : 'Enregistrer'}</button>
        </form>
        `
        }
      </div>
    `;

    container.querySelector('#form-paiement').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.put('/parametres-paiement/paiement', {
          mode: fd.get('mode'),
          master_key: fd.get('master_key'),
          private_key: fd.get('private_key'),
          public_key: fd.get('public_key'),
          token: fd.get('token'),
        });
        showToast('Identifiants de paiement enregistrés.', 'success');
        window.Views['parametres-paiement'].render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#form-whatsapp')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.put('/parametres-whatsapp', {
          access_token: fd.get('access_token'),
          phone_number_id: fd.get('phone_number_id'),
        });
        showToast('Identifiants WhatsApp enregistrés.', 'success');
        window.Views['parametres-paiement'].render(container);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },
};

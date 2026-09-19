window.Views = window.Views || {};

window.Views['parametres-paiement'] = {
  async render(container) {
    // Informations de la ferme = Socle Essentiel ; paiement PayDunya et relances WhatsApp = module
    // Finance (les routes correspondantes refusent un abonnement sans ce module, voir modulesSaas.js).
    const avecFinance = window.aModule('finance');
    const [config, configWhatsapp, infoFerme] = await Promise.all([
      avecFinance ? Api.get('/parametres-paiement/paiement') : null,
      avecFinance ? Api.get('/parametres-whatsapp') : null,
      Api.get('/parametres-ferme'),
    ]);

    container.innerHTML = `
      <div class="panel">
        <h2>Informations de la ferme</h2>
        <p class="desc">
          Adresse et téléphone apparaissent sur l'en-tête de vos factures PDF. Les coordonnées GPS
          définissent le dépôt de départ des tournées de livraison (module Logistique) — sans elles,
          un dépôt par défaut est utilisé.
        </p>
        <form id="form-ferme" class="form-grid" autocomplete="off">
          <label>Adresse<input type="text" name="adresse" value="${esc(infoFerme.adresse || '')}" placeholder="Ex : Route de Diamniadio, Dakar" /></label>
          <label>Téléphone<input type="text" name="telephone" value="${esc(infoFerme.telephone || '')}" placeholder="Ex : 77 123 45 67" /></label>
          <label>Latitude du dépôt<input type="text" name="gps_lat" value="${esc(infoFerme.gps_lat ?? '')}" placeholder="Ex : 14.7247" /></label>
          <label>Longitude du dépôt<input type="text" name="gps_lng" value="${esc(infoFerme.gps_lng ?? '')}" placeholder="Ex : -17.1875" /></label>
          <button type="submit">Enregistrer</button>
        </form>
      </div>

      ${
        avecFinance
          ? ''
          : `<div class="panel">
        <h2>Paiement mobile et relances WhatsApp</h2>
        <p class="desc">Ces réglages (compte PayDunya, relances de vos clients par WhatsApp) font partie du module Finance, qui n'est pas inclus dans votre abonnement actuel. Contactez-nous pour l'activer.</p>
      </div>`
      }

      ${
        !avecFinance
          ? ''
          : `<div class="panel">
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
        <form id="form-paiement" class="form-grid" autocomplete="off">
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
      </div>`
      }

      ${
        !avecFinance
          ? ''
          : `<div class="panel">
        <h2>Relances clients par WhatsApp</h2>
        <label style="display:flex;flex-direction:row;align-items:flex-start;gap:8px;margin-bottom:14px">
          <input type="checkbox" id="relances-auto" ${configWhatsapp.relancesAutoActives ? 'checked' : ''} style="width:auto;flex:none;margin-top:3px" />
          <span>
            <strong>Relance automatique 7 jours après l'échéance</strong><br />
            <span class="desc" style="margin:0">Une facture impayée est relancée une seule fois par WhatsApp, 7 jours après sa date d'échéance, entre 9 h et 18 h. Les relances suivantes restent manuelles (bouton « Rappel WhatsApp » de l'écran Finances).</span>
          </span>
        </label>
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
        <form id="form-whatsapp" class="form-grid" autocomplete="off">
          <label>Jeton d'accès (Access Token)<input type="password" name="access_token" autocomplete="off" required /></label>
          <label>ID du numéro de téléphone (Phone Number ID)<input type="text" name="phone_number_id" autocomplete="off" required /></label>
          <button type="submit">${configWhatsapp.configure ? 'Remplacer les identifiants' : 'Enregistrer'}</button>
        </form>
        `
        }
      </div>`
      }
    `;

    container.querySelector('#form-ferme').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await Api.put('/parametres-ferme', {
          adresse: fd.get('adresse'),
          telephone: fd.get('telephone'),
          gps_lat: fd.get('gps_lat'),
          gps_lng: fd.get('gps_lng'),
        });
        showToast('Informations de la ferme enregistrées.', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    container.querySelector('#form-paiement')?.addEventListener('submit', async (e) => {
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

    container.querySelector('#relances-auto')?.addEventListener('change', async (e) => {
      const coche = e.target.checked;
      try {
        await Api.put('/parametres-whatsapp/relances-auto', { actives: coche });
        showToast(coche ? 'Relance automatique activée.' : 'Relance automatique désactivée.', 'success');
      } catch (err) {
        e.target.checked = !coche;
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

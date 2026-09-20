// Suivi marketing du tunnel massla.sn (visite → clic contact → demande de démonstration → compte créé).
// Chargé uniquement par decouvrir.html et inscription.html (jamais dans l'application de gestion) ;
// la CSP de ces deux pages seulement est ouverte à Google et Meta (server/src/csp.js).
//
// Identifiants (publics, visibles dans le code de la page) :
//   GA_MEASUREMENT_ID : Google Analytics 4 > Administration > Flux de données > ID de mesure
//   META_PIXEL_ID     : Meta Business Suite > Gestionnaire d'évènements > Ensembles de données (pixel web)
// Laisser un identifiant vide désactive l'outil correspondant : aucune requête n'est alors envoyée.
window.MassiaAnalytics = (function () {
  const GA_MEASUREMENT_ID = 'G-XDMN4BYRFT';
  const META_PIXEL_ID = '1999683867413513';

  // Choix du visiteur, mémorisé dans son navigateur : 'ok' (informé) ou 'refus' (suivi coupé). Sans
  // choix, le suivi démarre et un bandeau discret l'informe avec un bouton "Refuser". Le signal
  // "Do Not Track" du navigateur est aussi respecté.
  const CLE_CHOIX = 'massla_suivi';
  function lireChoix() {
    try { return localStorage.getItem(CLE_CHOIX); } catch (e) { return null; }
  }
  function ecrireChoix(valeur) {
    try { localStorage.setItem(CLE_CHOIX, valeur); } catch (e) { /* stockage indisponible : sans effet */ }
  }
  function suiviAutorise() {
    return lireChoix() !== 'refus' && navigator.doNotTrack !== '1';
  }

  // Évènements de conversion standard, reconnus par Google (recommandés) et Meta (optimisation des
  // publicités) EN PLUS de l'évènement personnalisé : les campagnes apprennent sur "Lead", pas sur un nom maison.
  const EVENEMENTS_STANDARD = {
    contact_form_envoye: { ga: 'generate_lead', meta: 'Lead' },
    compte_cree: { ga: 'sign_up', meta: 'CompleteRegistration' },
  };

  function chargerOutils() {
    if (GA_MEASUREMENT_ID) {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
      document.head.appendChild(s);
      window.dataLayer = window.dataLayer || [];
      window.gtag = function gtag() { window.dataLayer.push(arguments); };
      window.gtag('js', new Date());
      window.gtag('config', GA_MEASUREMENT_ID);
    }

    if (META_PIXEL_ID) {
      /* eslint-disable */
      !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
      n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
      n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
      t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
      document,'script','https://connect.facebook.net/en_US/fbevents.js');
      /* eslint-enable */
      window.fbq('init', META_PIXEL_ID);
      window.fbq('track', 'PageView');
    }
  }

  function couperSuivi() {
    if (GA_MEASUREMENT_ID) window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
    if (window.fbq) window.fbq('consent', 'revoke');
  }

  function track(eventName, params) {
    if (!suiviAutorise()) return;
    const standard = EVENEMENTS_STANDARD[eventName];
    if (GA_MEASUREMENT_ID && window.gtag) {
      window.gtag('event', eventName, params || {});
      if (standard) window.gtag('event', standard.ga, params || {});
    }
    if (META_PIXEL_ID && window.fbq) {
      window.fbq('trackCustom', eventName, params || {});
      if (standard) window.fbq('track', standard.meta, params || {});
    }
  }

  // Bandeau d'information : une seule fois par navigateur, jamais bloquant (coin bas de l'écran).
  function afficherBandeau() {
    if (lireChoix() || !(GA_MEASUREMENT_ID || META_PIXEL_ID)) return;
    const bandeau = document.createElement('div');
    bandeau.setAttribute('role', 'region');
    bandeau.setAttribute('aria-label', 'Mesure d\'audience');
    bandeau.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;max-width:520px;z-index:9999;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 14px;background:#1b1f24;color:#f2f4f5;border-radius:10px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    const texte = document.createElement('span');
    texte.style.cssText = 'flex:1 1 220px';
    texte.textContent = 'Ce site mesure sa fréquentation (Google Analytics, Meta) pour améliorer ses pages. Vous pouvez refuser.';
    const bouton = (libelle, valeur, principal) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = libelle;
      b.style.cssText = `padding:7px 14px;border-radius:8px;font:inherit;cursor:pointer;border:1px solid #6b7580;${principal ? 'background:#f2f4f5;color:#1b1f24;border-color:#f2f4f5' : 'background:transparent;color:#f2f4f5'}`;
      b.addEventListener('click', () => {
        ecrireChoix(valeur);
        if (valeur === 'refus') couperSuivi();
        bandeau.remove();
      });
      return b;
    };
    bandeau.append(texte, bouton('Refuser', 'refus', false), bouton('OK', 'ok', true));
    document.body.appendChild(bandeau);
  }

  if (suiviAutorise()) chargerOutils();

  // Attache automatiquement le suivi à tout élément marqué data-track="nom_evenement",
  // pour ne jamais avoir à toucher analytics.js quand on ajoute un nouveau CTA.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-track]').forEach((el) => {
      el.addEventListener('click', () => track(el.dataset.track, {}));
    });
    afficherBandeau();
  });

  return { track };
})();

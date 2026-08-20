// Suivi marketing minimal pour le tunnel massla.sn (visite → clic contact → compte créé).
// Désactivé tant que les identifiants ci-dessous sont vides — aucune requête envoyée à Google/Meta
// dans ce cas, pour ne jamais faire tourner un traceur cassé avec un faux identifiant.
//
// Pour activer :
//   1. GA_MEASUREMENT_ID : Google Analytics 4 > Administration > Flux de données > ID de mesure (G-XXXXXXXXXX)
//   2. META_PIXEL_ID     : Meta Business Suite > Gestionnaire d'évènements > ID du pixel
window.MassiaAnalytics = (function () {
  const GA_MEASUREMENT_ID = '';
  const META_PIXEL_ID = '';

  if (GA_MEASUREMENT_ID) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID);
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

  function track(eventName, params) {
    if (GA_MEASUREMENT_ID && window.gtag) window.gtag('event', eventName, params || {});
    if (META_PIXEL_ID && window.fbq) window.fbq('trackCustom', eventName, params || {});
  }

  // Attache automatiquement le suivi à tout élément marqué data-track="nom_evenement",
  // pour ne jamais avoir à toucher analytics.js quand on ajoute un nouveau CTA.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-track]').forEach((el) => {
      el.addEventListener('click', () => track(el.dataset.track, {}));
    });
  });

  return { track };
})();

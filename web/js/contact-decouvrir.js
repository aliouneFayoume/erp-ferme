(function () {
  const overlay = document.getElementById('modal-contact');
  const closeBtn = document.getElementById('modal-contact-close');
  const form = document.getElementById('form-contact');
  const errEl = document.getElementById('contact-error');
  const successEl = document.getElementById('contact-success');
  const submitBtn = document.getElementById('contact-submit');
  if (!overlay || !form) return;

  // Deux portes d'entrée, un seul formulaire : « Essayer gratuitement » (data-source="essai") et « Demander ma démo ».
  // Le type de demande part avec le formulaire (voir routes/contact.js) pour mesurer ce qui amène les fermes.
  const TEXTES = {
    demo: {
      titre: 'Demander ma démo gratuite',
      lede: 'Laissez vos coordonnées, nous vous recontactons rapidement pour organiser votre démonstration gratuite.',
      envoi: 'Envoyer ma demande',
    },
    essai: {
      titre: 'Essayer gratuitement',
      lede: 'Laissez vos coordonnées : nous ouvrons avec vous, sur WhatsApp, votre essai gratuit de 30 jours. Sans carte bancaire, sans engagement.',
      envoi: 'Demander mon essai',
    },
  };
  let source = 'demo';
  function appliquerTextes() {
    const t = TEXTES[source];
    const titre = document.getElementById('modal-contact-title');
    const lede = overlay.querySelector('.modal-lede');
    if (titre) titre.textContent = t.titre;
    if (lede) lede.textContent = t.lede;
    submitBtn.textContent = t.envoi;
  }

  // Même règle que server/src/validation.js (normaliserTelephone) : le serveur reste l'autorité, ceci
  // évite seulement un aller-retour et corrige le numéro pendant la saisie.
  function normaliserTelephone(saisie) {
    const texte = String(saisie || '').trim();
    if (!/^[+\d(][\d\s().-]*$/.test(texte)) return null;
    let chiffres = texte.replace(/\D/g, '');
    if (texte.startsWith('+')) {
      // indicatif déjà fourni
    } else if (chiffres.startsWith('00')) {
      chiffres = chiffres.slice(2);
    } else if (chiffres.length === 9 && /^7[05678]/.test(chiffres)) {
      chiffres = `221${chiffres}`;
    } else if (/^221\d{9}$/.test(chiffres)) {
      // "221 77 000 00 00" sans le +
    } else {
      return null;
    }
    if (chiffres.length < 8 || chiffres.length > 15) return null;
    if (chiffres.startsWith('0')) return null;
    if (chiffres.startsWith('221') && chiffres.length !== 12) return null;
    return `+${chiffres}`;
  }

  // "+221 77 000 00 00" pour le Sénégal, "+" + chiffres ailleurs.
  function formaterTelephone(e164) {
    if (e164.startsWith('+221')) {
      const n = e164.slice(4);
      return `+221 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5, 7)} ${n.slice(7, 9)}`;
    }
    return e164;
  }

  const champWhatsapp = document.getElementById('contact-whatsapp');
  champWhatsapp?.addEventListener('blur', () => {
    const normalise = normaliserTelephone(champWhatsapp.value);
    if (normalise) champWhatsapp.value = formaterTelephone(normalise);
  });

  function ouvrir(mode) {
    source = mode === 'essai' ? 'essai' : 'demo';
    appliquerTextes();
    form.hidden = false;
    successEl.hidden = true;
    errEl.hidden = true;
    overlay.hidden = false;
    document.getElementById('contact-nom')?.focus();
  }

  function fermer() {
    overlay.hidden = true;
  }

  // Tous les boutons "démonstration" (barre du haut, en-tête, bas de page) ouvrent ce formulaire ;
  // le href="#contact" reste un repli si le JavaScript n'est pas chargé.
  //
  // Essai gratuit autonome : quand le serveur annonce l'essai ouvert (/api/essai/disponible : interrupteur ESSAI_AUTONOME_ACTIF
  // + modèle WhatsApp d'authentification approuvé), « Essayer gratuitement » mène à l'inscription par téléphone au lieu
  // d'ouvrir ce formulaire. Tant qu'il est fermé (ou si la requête échoue), rien ne change. « Demander ma démo » garde toujours
  // le formulaire : c'est une demande de démonstration avec une personne.
  let essaiOuvert = false;
  fetch('/api/essai/disponible')
    .then((r) => r.json())
    .then((d) => {
      essaiOuvert = !!(d && d.disponible);
    })
    .catch(() => {});

  document.querySelectorAll('[data-open-contact]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (essaiOuvert && el.dataset.source === 'essai') {
        window.location.href = '/essai.html?source=essai';
        return;
      }
      ouvrir(el.dataset.source);
    });
  });
  closeBtn?.addEventListener('click', fermer);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) fermer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) fermer();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    const data = new FormData(form);
    const whatsapp = normaliserTelephone(data.get('whatsapp'));
    if (!whatsapp) {
      errEl.textContent = "Numéro WhatsApp invalide. Indiquez-le avec l'indicatif du pays, par exemple +221 77 000 00 00.";
      errEl.hidden = false;
      champWhatsapp?.focus();
      return;
    }
    const secteurs = data.getAll('secteur');
    if (secteurs.length === 0) {
      errEl.textContent = 'Choisissez au moins un secteur.';
      errEl.hidden = false;
      form.querySelector('input[name="secteur"]')?.focus();
      return;
    }
    const body = {
      nom: data.get('nom'),
      email: data.get('email'),
      whatsapp,
      secteurs,
      nomFerme: data.get('nomFerme') || '',
      ville: data.get('ville') || '',
      source,
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Envoi...';
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.erreur || "Erreur lors de l'envoi.");
      window.MassiaAnalytics?.track('contact_form_envoye', { source });
      form.reset();
      form.hidden = true;
      successEl.hidden = false;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = TEXTES[source].envoi;
    }
  });
})();

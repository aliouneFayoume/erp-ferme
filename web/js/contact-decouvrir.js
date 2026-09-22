(function () {
  const overlay = document.getElementById('modal-contact');
  const closeBtn = document.getElementById('modal-contact-close');
  const form = document.getElementById('form-contact');
  const errEl = document.getElementById('contact-error');
  const successEl = document.getElementById('contact-success');
  const submitBtn = document.getElementById('contact-submit');
  if (!overlay || !form) return;

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

  function ouvrir() {
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
  document.querySelectorAll('[data-open-contact]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      ouvrir();
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
    const body = {
      nom: data.get('nom'),
      email: data.get('email'),
      whatsapp,
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
      window.MassiaAnalytics?.track('contact_form_envoye');
      form.reset();
      form.hidden = true;
      successEl.hidden = false;
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Envoyer ma demande';
    }
  });
})();

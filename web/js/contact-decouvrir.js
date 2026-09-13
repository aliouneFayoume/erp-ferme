(function () {
  const overlay = document.getElementById('modal-contact');
  const openBtn = document.getElementById('btn-open-contact-modal');
  const closeBtn = document.getElementById('modal-contact-close');
  const form = document.getElementById('form-contact');
  const errEl = document.getElementById('contact-error');
  const successEl = document.getElementById('contact-success');
  const submitBtn = document.getElementById('contact-submit');
  if (!overlay || !form) return;

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

  openBtn?.addEventListener('click', ouvrir);
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
    const body = {
      nom: data.get('nom'),
      email: data.get('email'),
      whatsapp: data.get('whatsapp'),
      preference: data.get('preference'),
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

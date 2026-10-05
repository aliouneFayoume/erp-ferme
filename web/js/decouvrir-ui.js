// Comportements de la page d'accueil (decouvrir.html) : menu du téléphone et barre « Demander ma démo ».
// Rien d'autre côté script : l'accordéon FAQ et le détail des tarifs reposent sur <details>.
(function () {
  const menu = document.querySelector('.menu-mobile');
  if (menu) {
    menu.querySelectorAll('a').forEach((lien) => lien.addEventListener('click', () => { menu.open = false; }));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
    });
  }

  // Barre fixe du téléphone : visible une fois le premier écran passé, masquée quand le formulaire est à l'écran.
  const barre = document.getElementById('barre-demo');
  const boutonsHero = document.getElementById('hero-cta');
  const contact = document.getElementById('contact');
  if (barre && boutonsHero && contact && 'IntersectionObserver' in window) {
    let heroVisible = true;
    let contactVisible = false;
    const majBarre = () => barre.classList.toggle('visible', !heroVisible && !contactVisible);
    const observateur = new IntersectionObserver((entrees) => {
      entrees.forEach((e) => {
        if (e.target === boutonsHero) heroVisible = e.isIntersecting;
        if (e.target === contact) contactVisible = e.isIntersecting;
      });
      majBarre();
    });
    observateur.observe(boutonsHero);
    observateur.observe(contact);
  }
})();

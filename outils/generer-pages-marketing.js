// Génère les pages de secteur et les pages légales de massla.sn, ainsi que sitemap.xml et robots.txt.
//
// Usage (depuis erp-ferme/) :  node outils/generer-pages-marketing.js
//
// L'en-tête, le pied de page, la barre « Demander ma démo » et le formulaire de démonstration sont COPIÉS de
// web/decouvrir.html : modifier la page d'accueil puis relancer ce script suffit à garder toutes les pages cohérentes.
// Les textes viennent de outils/contenu-marketing.js. Les fichiers produits (web/*.html) sont commités ; ce script
// ne tourne ni en production ni dans la construction de l'image Docker.
const fs = require('fs');
const path = require('path');
const { SITE, SECTEURS, MENTIONS, CONFIDENTIALITE } = require('./contenu-marketing');
const { PAGES_PUBLIQUES } = require('../server/src/pagesPubliques');

const WEB = path.join(__dirname, '..', 'web');
const accueil = fs.readFileSync(path.join(WEB, 'decouvrir.html'), 'utf8').replace(/\r\n/g, '\n');
const DATE_SITEMAP = '2026-10-05';

function extraire(debut, fin, inclureFin = true) {
  const i = accueil.indexOf(debut);
  if (i < 0) throw new Error(`Repère introuvable dans decouvrir.html : ${debut}`);
  const j = accueil.indexOf(fin, i + debut.length);
  if (j < 0) throw new Error(`Repère de fin introuvable dans decouvrir.html : ${fin}`);
  return accueil.slice(i, inclureFin ? j + fin.length : j);
}

const ENTETE = extraire('<a class="aller-au-contenu"', '</header>');
const PIED = extraire('<footer class="pied">', '</footer>');
const BARRE = extraire('<div class="barre-demo"', '</div>');
const MODAL_CONTACT = extraire('<div class="modal-overlay" id="modal-contact"', '<div class="modal-overlay" id="modal-avis"', false).trimEnd();
const BOUTON_WHATSAPP = accueil.match(/<a class="btn btn-contour-clair" href="https:\/\/wa\.me\/[^"]+"[^>]*>[^<]*<\/a>/)?.[0];
if (!BOUTON_WHATSAPP) throw new Error('Bouton WhatsApp introuvable dans decouvrir.html');

const echapper = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sansBalises = (t) => String(t).replace(/<[^>]+>/g, '');

// Liens d'ancre de la page d'accueil → liens complets ; sur les pages sans formulaire, le bouton de démo renvoie à l'accueil.
function adapter(html, { avecFormulaire }) {
  let r = html.replace(/href="#(secteurs|fonctionnalites|tarifs|faq)"/g, 'href="/decouvrir#$1"');
  if (!avecFormulaire) r = r.replace(/href="#contact" data-open-contact/g, 'href="/decouvrir#contact"');
  return r;
}

function tete({ slug, titre, description, avecSuivi, precharger = '', jsonld = [] }) {
  const url = `${SITE}/${slug}`;
  const scripts = jsonld.map((j) => `  <script type="application/ld+json">\n${JSON.stringify(j, null, 2).replace(/</g, '\\u003c')}\n  </script>`).join('\n');
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${echapper(titre)}</title>
  <meta name="description" content="${echapper(description)}" />
  <link rel="canonical" href="${url}" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="fr_SN" />
  <meta property="og:site_name" content="Massla" />
  <meta property="og:title" content="${echapper(titre)}" />
  <meta property="og:description" content="${echapper(description)}" />
  <meta property="og:url" content="${url}" />
  <meta property="og:image" content="${SITE}/img/og-massla.jpg" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:type" content="image/jpeg" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${SITE}/img/og-massla.jpg" />
  <link rel="icon" href="/icons/massla-favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/massla-icone-app.svg" />
  <meta name="theme-color" content="#0F3D2E" />
  <link rel="preload" href="/fonts/Onest-Variable.woff2" as="font" type="font/woff2" crossorigin />
${precharger}  <link rel="stylesheet" href="/css/massla-tokens.css" />
  <link rel="stylesheet" href="/css/decouvrir.css" />
${avecSuivi ? '  <script src="/js/dist/marketing.min.js"></script>\n' : ''}${scripts}
</head>
<body>
`;
}

const faqJsonLd = (faq) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faq.map((f) => ({ '@type': 'Question', name: sansBalises(f.q), acceptedAnswer: { '@type': 'Answer', text: sansBalises(f.a) } })),
});
const filAriane = (nom, slug) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Massla', item: `${SITE}/decouvrir` },
    { '@type': 'ListItem', position: 2, name: nom, item: `${SITE}/${slug}` },
  ],
});

// ------------------------------------------------------------------------------------------------ pages de secteur
function pageSecteur(s) {
  const autres = SECTEURS.filter((x) => x.slug !== s.slug);
  const blocs = s.blocs
    .map((b) => `        <div class="carte fonction"><span class="pastille"><span class="ico ic-${b.icone}" aria-hidden="true"></span></span><div><h3>${echapper(b.titre)}</h3><p>${echapper(b.texte)}</p></div></div>`)
    .join('\n');
  const etapes = s.etapes
    .map((e, i) => `        <div class="etape"><div class="etape-num">0${i + 1}</div><h3>${echapper(e.titre)}</h3><p>${echapper(e.texte)}</p></div>`)
    .join('\n');
  const faq = s.faq
    .map((f, i) => `        <details name="faq"${i === 0 ? ' open' : ''}>\n          <summary>${echapper(f.q)}</summary>\n          <p>${echapper(f.a)}</p>\n        </details>`)
    .join('\n');
  const captures = s.captures
    ? `
  <section class="section-claire">
    <div class="wrap duo">
      <div class="duo-texte">
        <p class="surtitre">En pratique</p>
        <h2>Le relevé du jour, directement sur le téléphone</h2>
        <p class="intro">Mortalité, aliment, poids, œufs : le gérant ou l'employé note la journée dans le poulailler, même sans réseau. Massla met à jour l'effectif et le stock tout seul.</p>
      </div>
      <div class="duo-visuel">
        <figure class="telephone">
          <img src="/img/aviculture-lots.webp" width="375" height="812" loading="lazy" decoding="async" alt="Écran Massla : la carte d'un lot avicole avec son effectif de 500 sujets et le bouton Saisir un relevé" />
          <figcaption>Le lot, son effectif, un bouton pour saisir la journée</figcaption>
        </figure>
        <figure class="telephone">
          <img src="/img/aviculture-releve.webp" width="375" height="812" loading="lazy" decoding="async" alt="Écran Massla : le relevé du jour d'un lot avicole avec la mortalité, l'aliment, le poids et les œufs collectés" />
          <figcaption>Le relevé du jour : mortalité, aliment, poids, œufs</figcaption>
        </figure>
      </div>
    </div>
  </section>
`
    : '';
  const note = s.note ? `\n      <p class="note-secteur">${echapper(s.note)}</p>` : '';
  const voisins = autres.map((x) => `<li><a class="puce-secteur" href="/${x.slug}">${echapper(x.nom)}</a></li>`).join('');

  const hero = `
<main id="contenu">

  <section class="hero section-claire">
    <div class="wrap">
      <div class="hero-texte">
        <nav class="fil-ariane" aria-label="Fil d'Ariane"><a href="/decouvrir">Massla</a> <span aria-hidden="true">›</span> <span>${echapper(s.nom)}</span></nav>
        <p class="surtitre">${echapper(s.nom)} au Sénégal</p>
        <h1>${s.h1}</h1>
        <p class="chapeau">${echapper(s.intro)}</p>
        <div class="cta-row" id="hero-cta">
          <a class="btn btn-principal" href="#contact" data-open-contact data-track="clic_cta_secteur_${s.slug}">Demander ma démo gratuite</a>
          <a class="btn btn-contour" href="/decouvrir#tarifs">Voir les tarifs</a>
        </div>
      </div>
      <figure class="hero-visuel" style="margin:0">
        <img src="${s.image.src}" width="720" height="411" fetchpriority="high" decoding="async" alt="${echapper(s.image.alt)}" />
      </figure>
    </div>
  </section>

  <section class="section-blanche">
    <div class="wrap">
      <p class="surtitre">Ce que fait Massla</p>
      <h2>${echapper(s.blocsTitre)}</h2>
      <div class="grille grille-3">
${blocs}
      </div>${note}
    </div>
  </section>
${captures}
  <section class="section-claire">
    <div class="wrap">
      <p class="surtitre">Au quotidien</p>
      <h2>Une journée avec Massla</h2>
      <div class="etapes">
${etapes}
      </div>
    </div>
  </section>

  <section class="section-blanche">
    <div class="wrap">
      <p class="surtitre">Questions fréquentes</p>
      <h2>${echapper(s.nom)} : ce que demandent les gérants</h2>
      <div class="faq">
${faq}
      </div>
    </div>
  </section>

  <section class="section-claire">
    <div class="wrap">
      <p class="surtitre">Autres secteurs</p>
      <h2>Massla couvre toute votre exploitation</h2>
      <ul class="puces-secteurs" aria-label="Autres secteurs">${voisins}</ul>
    </div>
  </section>

  <section id="contact" class="section-sahel final">
    <div class="wrap">
      <h2>Voyez Massla sur votre propre téléphone</h2>
      <p class="intro">Une démonstration gratuite de 15 minutes, sans engagement, avec un exemple adapté à votre ${echapper(s.nom.toLowerCase())}.</p>
      <div class="cta-row">
        <button type="button" class="btn btn-accent" data-open-contact data-track="clic_ouvrir_modal_contact_${s.slug}">Demander ma démo gratuite</button>
        ${BOUTON_WHATSAPP}
      </div>
    </div>
  </section>

</main>
`;
  return (
    tete({
      slug: s.slug, titre: s.titre, description: s.description, avecSuivi: true,
      precharger: `  <link rel="preload" href="${s.image.src}" as="image" fetchpriority="high" />\n`,
      jsonld: [filAriane(s.nom, s.slug), faqJsonLd(s.faq)],
    }) +
    `\n${adapter(ENTETE, { avecFormulaire: true })}\n` +
    hero +
    `\n${adapter(PIED, { avecFormulaire: true })}\n\n${BARRE}\n\n${MODAL_CONTACT}\n\n<script src="/js/dist/contact-decouvrir.min.js"></script>\n</body>\n</html>\n`
  );
}

// -------------------------------------------------------------------------------------------------- pages légales
function pageLegale(p, { avecSuivi, scriptPropre }) {
  return (
    tete({ slug: p.slug, titre: p.titre, description: p.description, avecSuivi, jsonld: [filAriane(p.h1, p.slug)] }) +
    `\n${adapter(ENTETE, { avecFormulaire: false })}\n` +
    `
<main id="contenu" class="page-legale">
  <div class="wrap">
    <div class="texte-legal">
      <h1>${echapper(p.h1)}</h1>
      <p class="maj">Dernière mise à jour : ${echapper(p.miseAJour)}</p>
${p.corps}
    </div>
  </div>
</main>
` +
    `\n${adapter(PIED, { avecFormulaire: false })}\n\n<script src="/js/dist/contact-decouvrir.min.js"></script>\n${scriptPropre ? `<script src="/js/dist/${scriptPropre}"></script>\n` : ''}</body>\n</html>\n`
  );
}

// ------------------------------------------------------------------------------------------------------- écriture
const ecrire = (nom, contenu) => {
  fs.writeFileSync(path.join(WEB, nom), contenu);
  console.log('écrit', nom, `(${Buffer.byteLength(contenu)} octets)`);
};

for (const s of SECTEURS) ecrire(`${s.slug}.html`, pageSecteur(s));
ecrire('mentions.html', pageLegale(MENTIONS, { avecSuivi: false }));
ecrire('confidentialite.html', pageLegale(CONFIDENTIALITE, { avecSuivi: true, scriptPropre: 'confidentialite.min.js' }));

// Les pages listées dans pagesPubliques.js et celles générées ici doivent être les mêmes (sinon une route ou une règle CSP manque).
const generees = [...SECTEURS.map((s) => s.slug), MENTIONS.slug, CONFIDENTIALITE.slug].sort().join(',');
if (generees !== [...PAGES_PUBLIQUES].sort().join(',')) throw new Error(`pagesPubliques.js (${PAGES_PUBLIQUES}) ne correspond pas aux pages générées (${generees})`);

const urls = ['/decouvrir', ...SECTEURS.map((s) => `/${s.slug}`), '/mentions', '/confidentialite'];
ecrire(
  'sitemap.xml',
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${DATE_SITEMAP}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`
);
ecrire('robots.txt', `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE}/sitemap.xml\n`);

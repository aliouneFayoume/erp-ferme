// Textes des pages de secteur et des pages légales de massla.sn. Chaque affirmation sur l'application correspond à une
// fonction réellement présente (relevés, effectif, stock, déplacements de poissons, gestations…) : ne rien ajouter ici
// qui ne soit pas vérifiable dans l'application. Le HTML est produit par generer-pages-marketing.js.

const SITE = 'https://massla.sn';

const PRIX_FAQ = (secteur) =>
  `À partir de 25 000 FCFA par mois avec le Socle Essentiel (tableau de bord, production, catalogue et stock, intrants, utilisateurs)${secteur}. ` +
  `Les modules Clients, Commandes, Finance ou Logistique s'ajoutent à la carte, ou le Pack tout compris est à 85 000 FCFA par mois. ` +
  `La mise en place, unique, est de 75 000 FCFA.`;

const HORS_LIGNE = (lieu) => ({
  q: `Peut-on saisir les relevés sans réseau ${lieu} ?`,
  a: "Oui. Le relevé est gardé sur le téléphone et envoyé automatiquement dès que la connexion revient. Chaque relevé n'est compté qu'une seule fois, même s'il est renvoyé.",
});

const SECTEURS = [
  {
    slug: 'aviculture',
    nom: 'Aviculture',
    titre: 'Logiciel de gestion de ferme avicole au Sénégal — Massla',
    description:
      "Suivez vos lots de volailles, la mortalité, l'aliment et la ponte depuis votre téléphone, même sans internet, et vos ventes d'œufs dans la même application. Massla, le logiciel de gestion des fermes avicoles au Sénégal.",
    h1: 'Le logiciel de gestion pour votre <em>ferme avicole</em>',
    intro:
      "Poulets de chair ou pondeuses : Massla suit chaque lot de sa mise en place à la vente, depuis le téléphone du gérant ou de ses employés, même quand le réseau coupe.",
    image: { src: '/img/secteur-avicole.webp', alt: 'Un éleveur consulte son téléphone dans un bâtiment avicole' },
    blocsTitre: 'Tout le suivi de votre poulailler',
    blocs: [
      { icone: 'modules', titre: 'Un lot par bande', texte: "Créez un lot pour chaque bande avec sa date de démarrage et son effectif. Vous retrouvez d'un coup d'œil les lots en cours et l'historique des lots clôturés." },
      { icone: 'livre', titre: 'Un relevé par jour', texte: "Mortalité, aliment consommé, poids moyen, œufs collectés : l'employé note la journée en quelques touches, avec de grands boutons faits pour le terrain." },
      { icone: 'tableau', titre: 'Un effectif toujours juste', texte: "La mortalité saisie est retirée automatiquement de l'effectif du lot. Plus de calcul à la main, plus d'écart entre le cahier et le poulailler." },
      { icone: 'modules', titre: "Stock d'aliment et d'œufs", texte: "L'aliment consommé est déduit du stock d'intrants. Les œufs ramassés entrent au stock, convertis en plateaux." },
      { icone: 'tableau', titre: 'Indice de consommation (FCR)', texte: "Massla calcule l'indice de consommation de chaque lot à partir de vos relevés, pour juger la rentabilité d'une bande avant d'en démarrer une autre." },
      { icone: 'portefeuille', titre: 'Ventes et paiements', texte: "Vendez vos œufs et vos volailles, encaissez par Wave et Orange Money et relancez les factures impayées par WhatsApp (modules Clients et Finance)." },
    ],
    captures: true,
    etapes: [
      { titre: 'Le matin, le relevé', texte: "L'employé ouvre le lot sur son téléphone et note la mortalité, l'aliment et les œufs." },
      { titre: 'Massla calcule', texte: "L'effectif, le stock d'aliment, le stock d'œufs et l'indice de consommation sont mis à jour tout seuls." },
      { titre: 'Le gérant suit à distance', texte: 'Où qu\'il soit, il voit le tableau de bord et les alertes de stock, même en dehors de la ferme.' },
    ],
    faq: [
      { q: 'Massla suit-il les pondeuses comme les poulets de chair ?', a: "Oui. Un lot peut être une bande de poulets de chair ou de pondeuses. Pour les pondeuses, le relevé du jour comprend les œufs collectés : ils entrent automatiquement au stock, convertis en plateaux (le nombre d'œufs par plateau est réglable)." },
      HORS_LIGNE('dans le poulailler'),
      { q: "Comment est calculé l'indice de consommation ?", a: "Massla le calcule à partir de l'aliment consommé et du poids relevé sur le lot. Tant qu'aucun poids n'a été saisi, il affiche « N/A »." },
      { q: 'Combien coûte Massla pour une ferme avicole ?', a: PRIX_FAQ('') },
    ],
  },
  {
    slug: 'pisciculture',
    nom: 'Pisciculture',
    titre: 'Logiciel de gestion de ferme piscicole au Sénégal — Massla',
    description:
      "Suivez vos bassins, vos alevins, l'aliment, le poids, la température et le pH de l'eau, et les déplacements de poissons depuis votre téléphone. Massla, le logiciel de gestion des fermes piscicoles au Sénégal.",
    h1: 'Le logiciel de gestion pour votre <em>ferme piscicole</em>',
    intro:
      "Bassins, alevins, grossissement : Massla suit chaque bassin au quotidien, y compris les passages d'un bassin à l'autre, depuis un simple téléphone.",
    image: { src: '/img/secteur-piscicole.webp', alt: 'Un pisciculteur remonte son filet dans un bassin' },
    blocsTitre: 'Tout le suivi de vos bassins',
    blocs: [
      { icone: 'modules', titre: 'Un lot par bassin', texte: "Chaque bassin a son effectif, sa date de démarrage et son espèce (tilapia, poisson-chat…). Selon votre organisation : éclosion, élevage larvaire, prégrossissement ou grossissement." },
      { icone: 'livre', titre: 'Le relevé du bassin', texte: "Mortalité, aliment, poids moyen, taille, température de l'eau et pH : tout se note dans le même relevé, sur le téléphone." },
      { icone: 'equipe', titre: 'Déplacer des poissons', texte: "Quand des poissons passent d'un bassin à l'autre, vous l'enregistrez une fois : les effectifs des deux bassins s'ajustent et l'historique des déplacements est conservé." },
      { icone: 'modules', titre: 'Aliment par type de bassin', texte: "Choisissez l'aliment de chaque étape d'élevage. Il est déduit du stock à chaque relevé." },
      { icone: 'tableau', titre: 'Rendement et indice de consommation', texte: "Massla calcule l'indice de consommation de chaque lot pour suivre le rendement de vos cycles." },
      { icone: 'portefeuille', titre: 'Récoltes, ventes et paiements', texte: "Suivez vos ventes de poisson jusqu'au paiement, par Wave et Orange Money." },
    ],
    etapes: [
      { titre: 'Le relevé du bassin', texte: "Le matin, l'employé note la mortalité, l'aliment, le poids, la taille et les mesures de l'eau." },
      { titre: 'Massla ajuste', texte: "L'effectif, le stock d'aliment et l'indice de consommation sont mis à jour sans ressaisie." },
      { titre: "Le gérant garde la vue d'ensemble", texte: "Tous les bassins sur un écran, avec l'historique des déplacements de poissons." },
    ],
    faq: [
      { q: 'Peut-on suivre plusieurs bassins et plusieurs espèces ?', a: "Oui. Chaque bassin est un lot avec son effectif et son espèce. Vous pouvez en suivre autant que nécessaire et les voir ensemble sur un seul écran." },
      { q: "Comment enregistrer le passage des alevins d'un bassin à l'autre ?", a: "Avec « Déplacer des poissons » sur la carte du bassin : vous indiquez le bassin d'arrivée et le nombre de poissons. Les effectifs et l'espèce suivent automatiquement, et un historique des déplacements est conservé." },
      { q: "Quelles mesures de l'eau peut-on noter ?", a: "La température de l'eau et le pH, en plus de la mortalité, de l'aliment, du poids moyen et de la taille moyenne." },
      HORS_LIGNE('au bord des bassins'),
      { q: 'Combien coûte Massla pour une ferme piscicole ?', a: PRIX_FAQ('') },
    ],
  },
  {
    slug: 'maraichage',
    nom: 'Maraîchage',
    titre: 'Logiciel de gestion maraîchère au Sénégal — Massla',
    description:
      "Suivez vos cultures, les dates de récolte, vos récoltes en kilos, vos stocks de légumes et vos ventes depuis votre téléphone. Massla, le logiciel de gestion des exploitations maraîchères au Sénégal.",
    h1: 'Le logiciel de gestion pour votre <em>exploitation maraîchère</em>',
    intro:
      "Du semis à la vente : Massla suit chaque culture, annonce les récoltes à venir et garde vos produits et vos ventes au même endroit.",
    image: { src: '/img/secteur-maraicher.webp', alt: 'Une maraîchère récolte des tomates dans son champ' },
    blocsTitre: 'Tout le suivi de vos cultures',
    blocs: [
      { icone: 'modules', titre: 'Une culture, un lot', texte: "Créez un lot par culture (tomate, chou, oignon…) avec sa date de démarrage et sa durée avant récolte." },
      { icone: 'tableau', titre: 'Les récoltes à venir', texte: "Massla calcule la date de récolte prévue de chaque culture et vous prévient quand une récolte approche, ou quand elle est en retard." },
      { icone: 'livre', titre: 'Le relevé du jour', texte: "Notez la récolte du jour en kilos et les intrants utilisés (engrais, traitements) au même endroit." },
      { icone: 'modules', titre: 'Un catalogue de produits frais', texte: "Gardez vos produits, leurs prix selon le type de client (particulier, restaurant, grossiste) et leur stock disponible." },
      { icone: 'equipe', titre: 'Lots terminés ou perdus', texte: "Clôturez une culture terminée, vendue ou perdue : son historique reste consultable." },
      { icone: 'portefeuille', titre: 'Ventes et paiements', texte: "Commandes, factures et paiements par Wave et Orange Money, en un seul endroit." },
    ],
    etapes: [
      { titre: 'Vous démarrez la culture', texte: 'Vous indiquez la culture, la date de démarrage et le nombre de jours avant la récolte.' },
      { titre: 'Massla suit la date de récolte', texte: "Le tableau de bord signale les récoltes prévues dans les 7 jours, et celles qui sont en retard." },
      { titre: 'Vous récoltez et vous vendez', texte: "La récolte est notée en kilos ; les ventes et les paiements se suivent dans la même application." },
    ],
    faq: [
      { q: 'Peut-on suivre plusieurs cultures en même temps ?', a: "Oui. Chaque culture est un lot avec sa propre date de démarrage et sa propre date de récolte prévue. Tous vos lots en cours sont visibles sur un seul écran." },
      { q: 'Comment être prévenu qu\'une récolte approche ?', a: "Le tableau de bord signale les récoltes prévues dans les 7 jours, et la carte de chaque culture indique si la récolte est en retard." },
      { q: 'Comment est calculée la date de récolte ?', a: "À partir de la date de démarrage et de la durée avant récolte que vous indiquez pour la culture (par exemple 90 jours)." },
      HORS_LIGNE('dans les champs'),
      { q: 'Combien coûte Massla pour une exploitation maraîchère ?', a: PRIX_FAQ('') },
    ],
  },
  {
    slug: 'elevage',
    nom: 'Élevage',
    titre: "Logiciel de gestion d'élevage bovin, ovin et caprin au Sénégal — Massla",
    description:
      "Une fiche par animal : poids, vaccinations, traitements, reproduction et généalogie. Massla, le logiciel de gestion d'élevage de bovins, ovins et caprins au Sénégal.",
    h1: 'Le logiciel de gestion pour votre <em>élevage</em> de bovins, ovins et caprins',
    intro:
      "Chaque animal a sa fiche : identité, poids, soins, reproduction. Massla garde l'historique complet, d'une année sur l'autre.",
    image: { src: '/img/secteur-elevage.webp', alt: 'Un éleveur avec son zébu, ses moutons et ses chèvres' },
    blocsTitre: 'Tout le suivi de votre troupeau',
    blocs: [
      { icone: 'personne', titre: 'Une fiche par animal', texte: "Identifiant (boucle), espèce, race, sexe, date de naissance, origine et poids initial." },
      { icone: 'equipe', titre: 'La généalogie', texte: "Pour les animaux nés sur la ferme, Massla garde le lien avec la mère." },
      { icone: 'tableau', titre: 'La reproduction', texte: "Enregistrez une saillie : la date de mise-bas prévue est calculée (283 jours pour les bovins, 150 pour les ovins et les caprins) et vous suivez les gestations en cours. Vous pouvez corriger la date." },
      { icone: 'livre', titre: 'Pesées et soins', texte: "Pesées, vaccinations, traitements, observations : chaque événement est daté et rangé dans l'historique de l'animal, avec sa courbe de poids. Saisissez même sans réseau : l'envoi se fait au retour de la connexion." },
      { icone: 'modules', titre: 'Le troupeau en un coup d\'œil', texte: "Retrouvez tous vos animaux, un par un, avec leur statut et leur historique." },
      { icone: 'portefeuille', titre: 'Ventes et sorties', texte: "La vente se fait dans les modules Clients, Commandes et Finance, avec un produit « tête » rattaché à Bovins, Ovins ou Caprins : facture, paiement mobile et chiffre d'affaires par espèce. Sur la fiche de l'animal, vous passez ensuite le statut à « Vendu » (ou Abattu, Mort) : la fiche garde la date de sortie. Les deux gestes restent distincts." },
    ],
    note: "Le suivi d'élevage est un module à 15 000 FCFA par mois, inclus dans le Pack tout compris.",
    etapes: [
      { titre: 'Vous créez la fiche', texte: "Vous enregistrez l'animal avec son identifiant, son espèce et sa date de naissance." },
      { titre: 'Vous notez les événements', texte: 'Pesée, vaccination, traitement, saillie : une saisie rapide, avec la date.' },
      { titre: "Massla vous rappelle l'essentiel", texte: 'Les gestations en cours et la date de mise-bas prévue sont affichées en tête de l\'écran Élevage.' },
    ],
    faq: [
      { q: 'Quels animaux peut-on suivre ?', a: "Les bovins, les ovins et les caprins, un par un, avec leur identifiant (boucle)." },
      { q: 'Comment Massla calcule-t-il la date de mise-bas ?', a: "À partir de la date de saillie, avec une durée de gestation moyenne : 283 jours pour les bovins, 150 jours pour les ovins et les caprins. Vous pouvez corriger la date ensuite." },
      { q: "Peut-on suivre l'historique de santé d'un animal ?", a: "Oui. Les vaccinations, les traitements, les pesées et les observations sont enregistrés avec leur date dans la fiche de chaque animal." },
      { q: 'Faut-il un abonnement séparé pour l\'élevage ?', a: "Le suivi d'élevage est un module à 15 000 FCFA par mois, en plus du Socle Essentiel (25 000 FCFA par mois). Il est inclus dans le Pack tout compris à 85 000 FCFA par mois." },
      {
        q: 'Peut-on saisir sans réseau dans les enclos ?',
        a: "Oui, pour les pesées, vaccinations, traitements et observations : le relevé est gardé sur le téléphone et envoyé automatiquement dès que le réseau revient, sans être compté deux fois. Les fiches déjà consultées restent lisibles. L'enregistrement d'un nouvel animal, d'une saillie ou d'une mise-bas demande en revanche une connexion.",
      },
    ],
  },
];

// ----------------------------------------------------------------------------------------------------------------
// Pages légales. Éléments d'identification : repris de la page d'accueil (raison sociale, adresse, NINEA, RCCM).
const MENTIONS = {
  slug: 'mentions',
  titre: 'Mentions légales — Massla',
  description: "Mentions légales du site massla.sn : éditeur FAYSSALAME, coordonnées, hébergement et propriété intellectuelle.",
  h1: 'Mentions légales',
  miseAJour: '5 octobre 2026',
  corps: `
<h2>Éditeur du site</h2>
<p>Le site <strong>massla.sn</strong> et l'application Massla sont édités par <strong>FAYSSALAME</strong>, société immatriculée au Registre du commerce et du crédit mobilier de Dakar.</p>
<ul>
  <li>Siège : Cité Castors Marine III, Villa 48, Dakar, Sénégal</li>
  <li>NINEA : 012050225</li>
  <li>RCCM : SN.DKR.2025.B.13520</li>
  <li>Contact : <a href="mailto:admin@massla.sn">admin@massla.sn</a> — WhatsApp : <a href="https://wa.me/14165266293" rel="noopener">+1 416 526 6293</a></li>
</ul>
<p>Le directeur de la publication est le représentant légal de FAYSSALAME.</p>

<h2>Hébergement</h2>
<ul>
  <li>Serveur de l'application et du site : Oracle Cloud Infrastructure (Oracle Corporation) — <a href="https://www.oracle.com/cloud/" rel="noopener">oracle.com/cloud</a></li>
  <li>Base de données : Supabase — <a href="https://supabase.com" rel="noopener">supabase.com</a></li>
</ul>

<h2>Propriété intellectuelle</h2>
<p>Les textes, les images, les logos, la présentation et le code de ce site et de l'application Massla appartiennent à FAYSSALAME ou à ses partenaires. Toute reproduction ou réutilisation, totale ou partielle, sans autorisation écrite préalable, est interdite.</p>

<h2>Responsabilité</h2>
<p>FAYSSALAME s'efforce de fournir des informations exactes et à jour sur ce site, sans pouvoir garantir l'absence totale d'erreur ou d'omission. Les tarifs indiqués sont ceux en vigueur à la date de consultation ; ils peuvent varier selon la taille de l'exploitation et sont confirmés lors de la démonstration. Le site peut contenir des liens vers des sites tiers, dont FAYSSALAME ne contrôle pas le contenu.</p>

<h2>Données personnelles</h2>
<p>Le traitement des données personnelles est décrit dans la <a href="/confidentialite">politique de confidentialité</a>.</p>

<h2>Droit applicable</h2>
<p>Le présent site est soumis au droit sénégalais. En cas de litige, et à défaut de solution amiable, les tribunaux de Dakar sont compétents.</p>
`,
};

const CONFIDENTIALITE = {
  slug: 'confidentialite',
  titre: 'Politique de confidentialité — Massla',
  description: "Comment Massla traite vos données personnelles : ce que nous collectons, pourquoi, avec qui nous les partageons, combien de temps nous les gardons et comment exercer vos droits.",
  h1: 'Politique de confidentialité',
  miseAJour: '5 octobre 2026',
  corps: `
<p>Cette page explique, simplement, quelles données personnelles Massla traite, pourquoi, et comment vous gardez la main dessus. Massla est édité par FAYSSALAME (voir les <a href="/mentions">mentions légales</a>), responsable du traitement pour les données décrites aux sections 1 et 2.</p>

<h2>1. Les visiteurs du site massla.sn</h2>
<h3>Demande de démonstration</h3>
<p>Quand vous remplissez le formulaire de démonstration, nous recevons votre nom, votre adresse e-mail, votre numéro WhatsApp, votre ou vos secteurs et, si vous les indiquez, le nom de votre ferme et votre ville. Nous les utilisons pour vous recontacter et organiser la démonstration. Nous les conservons le temps de traiter votre demande, puis jusqu'à 3 ans sans échange de votre part, sauf si vous demandez leur suppression avant.</p>
<h3>Avis clients</h3>
<p>Si vous laissez un avis, nous recevons votre nom, le nom de votre ferme (facultatif), votre note et votre commentaire. L'avis n'est publié qu'après vérification par notre équipe, avec votre nom. Vous pouvez demander son retrait à tout moment.</p>
<h3>Mesure d'audience</h3>
<p>Pour savoir quelles pages sont utiles et combien de demandes de démonstration elles génèrent, nous utilisons Google Analytics et le pixel Meta sur les pages publiques de ce site (accueil, pages de secteur, inscription, cette page). Ils enregistrent notamment les pages visitées, les clics sur les boutons de démonstration et l'envoi du formulaire. <strong>La mesure d'audience est active par défaut, et vous pouvez la refuser à tout moment</strong> : avec le bouton « Refuser » du bandeau, avec le bouton ci-dessous, ou avec le signal « Ne pas me suivre » de votre navigateur, que nous respectons. L'application de gestion elle-même (la partie connectée) ne contient aucun outil de suivi tiers.</p>
<div class="choix-audience" id="choix-audience">
  <p id="etat-audience" role="status">Chargement de votre choix…</p>
  <button type="button" class="btn btn-contour" id="btn-audience" hidden></button>
</div>

<h2>2. Les utilisateurs de l'application</h2>
<p>Pour créer et sécuriser votre compte, nous traitons votre nom, votre adresse e-mail, votre rôle dans la ferme, votre mot de passe (conservé uniquement sous forme chiffrée, jamais en clair), les informations de double authentification si vous l'activez, et un journal des actions importantes (connexions, modifications) qui sert à la sécurité et au support. Ces données sont conservées pendant la durée de votre accès, puis supprimées ou rendues anonymes à la fin du contrat, sous réserve des obligations légales de conservation.</p>
<p>Si vous recevez un message de Massla (vérification d'e-mail, réinitialisation de mot de passe, rappel de facture), il est envoyé à l'adresse ou au numéro WhatsApp enregistrés pour votre compte ou votre ferme.</p>

<h2>3. Les données saisies par une ferme dans l'application</h2>
<p>Les données que vous saisissez dans Massla pour gérer votre ferme (lots, relevés, animaux, stocks, clients, commandes, factures, salariés…) vous appartiennent. Pour ces données, <strong>votre ferme est responsable du traitement et FAYSSALAME agit pour son compte, comme sous-traitant</strong> : nous les hébergeons et les traitons uniquement pour faire fonctionner le service. Chaque ferme a ses données séparées de celles des autres fermes, au niveau de la base de données. Si vous saisissez des données personnelles de vos propres clients ou salariés, c'est à vous de les en informer.</p>

<h2>4. Avec qui nous partageons les données</h2>
<p>Nous ne vendons aucune donnée. Nous faisons appel à des prestataires qui interviennent pour notre compte, uniquement pour ce qui est nécessaire :</p>
<ul>
  <li><strong>Oracle Cloud Infrastructure</strong> : serveur de l'application et du site.</li>
  <li><strong>Supabase</strong> : base de données.</li>
  <li><strong>Resend</strong> : envoi des e-mails (vérification, réinitialisation de mot de passe, notifications).</li>
  <li><strong>Meta (WhatsApp Business)</strong> : envoi des rappels de facture et des codes de vérification par WhatsApp, lorsque cette fonction est utilisée.</li>
  <li><strong>PayDunya</strong> : paiements par Wave, Orange Money et carte. Massla ne reçoit ni ne conserve vos identifiants de paiement.</li>
  <li><strong>Anthropic</strong> : si l'assistant IA est activé pour votre ferme, les questions que vous lui posez lui sont transmises pour produire la réponse.</li>
  <li><strong>Google et Meta</strong> : mesure d'audience du site public (voir section 1).</li>
  <li><strong>Esri et unpkg</strong> : lorsque vous ouvrez une carte dans l'application (position d'une livraison ou d'un client), les fonds de carte sont fournis par Esri et la bibliothèque de cartographie par unpkg ; ces services voient alors votre adresse IP.</li>
</ul>
<p>Certains de ces prestataires sont situés ou hébergent leurs serveurs hors du Sénégal. Nous choisissons des prestataires reconnus et limitons les données transmises à ce qui est nécessaire.</p>

<h2>5. Sécurité</h2>
<p>Les échanges avec Massla sont chiffrés (HTTPS). Les mots de passe sont stockés chiffrés, la double authentification est disponible (et exigée pour les nouveaux administrateurs de ferme), les données de chaque ferme sont isolées, et des sauvegardes sont réalisées régulièrement. Aucun système n'est infaillible : si une violation de données vous concernait, nous vous informerions dans les meilleurs délais.</p>

<h2>6. Stockage sur votre appareil</h2>
<p>Pour fonctionner, l'application garde sur votre appareil votre session de connexion, vos préférences et les relevés saisis hors ligne en attente d'envoi. Ces éléments sont strictement nécessaires au service. Le choix de mesure d'audience décrit plus haut est lui aussi mémorisé dans votre navigateur.</p>

<h2>7. Vos droits</h2>
<p>Vous pouvez à tout moment demander l'accès à vos données, leur correction, leur suppression, ou vous opposer à leur utilisation, conformément à la loi sénégalaise n° 2008-12 du 25 janvier 2008 sur la protection des données à caractère personnel. Écrivez-nous à <a href="mailto:admin@massla.sn">admin@massla.sn</a> en précisant votre demande : nous répondons dans un délai d'un mois. Pour les données saisies par une ferme (section 3), la demande peut devoir passer par la ferme concernée, que nous aidons à y répondre.</p>
<p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la Commission de Protection des Données Personnelles (CDP) du Sénégal.</p>

<h2>8. Modifications</h2>
<p>Nous pouvons mettre à jour cette politique, par exemple lorsqu'un nouveau prestataire ou une nouvelle fonction apparaît. La date de dernière mise à jour figure en haut de la page.</p>
`,
};

module.exports = { SITE, SECTEURS, MENTIONS, CONFIDENTIALITE };

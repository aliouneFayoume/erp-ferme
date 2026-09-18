/**
 * Catalogue des modules SaaS vendables (grille tarifaire validée avec l'utilisateur, 2026-08-08,
 * révisée le 2026-08-27 pour Élevage et Paie, puis le 2026-09-18 : les modules sont désormais
 * APPLIQUÉS par le serveur — voir requireAuth(pool, { module }) dans auth.js — et plus seulement
 * descriptifs). Les prix réellement facturés restent négociés au cas par cas et stockés sur
 * organisation_abonnement_saas.montant_mensuel, jamais recalculés à partir de ce catalogue.
 *
 * Ce fichier est la SEULE source de vérité de "quel onglet / quelle API appartient à quoi" :
 * - `onglets` : clés d'onglets du frontend (TAB_DEFS dans web/js/app.js). Renvoyées au client par
 *   GET /api/auth/me pour masquer ce qui n'est pas souscrit. Un test vérifie que chaque onglet du
 *   frontend est classé exactement une fois ici (tests/modules-saas.test.js).
 * - `lecture` : autres modules dont ce module a besoin de LIRE les données (GET seulement) pour que
 *   ses écrans fonctionnent (ex. Commandes liste les clients pour saisir une commande). Ce n'est
 *   pas un accès au module : son onglet reste masqué et ses écritures restent refusées.
 * - Côté routes, chaque fichier appelle requireAuth(pool, { module: '<cle>' }).
 *
 * Règles d'application (auth.js) :
 * - Aucune ligne d'abonnement (ferme jamais mise sous facturation) OU organisation plateforme
 *   (Ferme Massla) OU Pack tout compris => aucune restriction.
 * - Sinon : Socle Essentiel + modules listés dans modules_actifs.
 *
 * Sécurité (mot de passe renforcé, vérification email, MFA) volontairement absente de ce
 * catalogue : incluse d'office dans le Socle Essentiel plutôt que facturée en option — la vendre
 * séparément donnerait l'impression que les non-payeurs sont moins protégés.
 */
const SOCLE_ESSENTIEL = {
    prixMensuelDefaut: 25000,
    label: 'Socle Essentiel (Tableau de bord, Production, Catalogue & Stock, Intrants & Stock, Utilisateurs, Réglages de la ferme — inclus dans tout abonnement)',
    onglets: ['dashboard', 'production', 'catalogue', 'intrants', 'utilisateurs', 'audit', 'parametres-paiement', 'mon-compte', 'assistant'],
};

const MODULES_SAAS = [
    { cle: 'clients_abonnements', label: 'Clients & Abonnements', prixMensuelDefaut: 10000, onglets: ['clients', 'abonnements'], lecture: [] },
    { cle: 'commandes_fournisseurs', label: 'Commandes & Fournisseurs', prixMensuelDefaut: 10000, onglets: ['commandes', 'fournisseurs'], lecture: ['clients_abonnements'] },
    { cle: 'comptabilite', label: 'Comptabilité', prixMensuelDefaut: 10000, onglets: ['comptabilite'], lecture: ['commandes_fournisseurs', 'finance'] },
    { cle: 'support', label: 'Support client', prixMensuelDefaut: 5000, onglets: ['tickets'], lecture: ['clients_abonnements'] },
    { cle: 'logistique', label: 'Logistique', prixMensuelDefaut: 15000, onglets: ['logistique'], lecture: ['commandes_fournisseurs', 'clients_abonnements'] },
    { cle: 'finance', label: 'Finance (encaissement PayDunya)', prixMensuelDefaut: 15000, onglets: ['finance'], lecture: ['commandes_fournisseurs', 'clients_abonnements'] },
    // Même palier que Logistique/Finance : suivi individuel le plus sophistiqué du catalogue
    // (généalogie, reproduction), mais pas un besoin universel (uniquement les fermes avec ruminants).
    { cle: 'elevage', label: 'Élevage (suivi individuel bovins/ovins/caprins)', prixMensuelDefaut: 15000, onglets: ['elevage'], lecture: [] },
    // Même palier que Comptabilité/Clients & Abonnements : module administratif standard.
    { cle: 'paie', label: 'Paie', prixMensuelDefaut: 10000, onglets: ['paie'], lecture: [] },
];

// 85000 = ~72% de la somme à la carte (Socle 25000 + 8 modules 90000 = 115000), même taux de
// remise qu'avant l'ajout d'Élevage/Paie (65000 pour 90000 à la carte).
const PACK_TOUT_COMPRIS = { cle: 'pack_tout_compris', label: 'Pack tout compris', prixMensuelDefaut: 85000 };

const FRAIS_CONFIGURATION_DEFAUT = 75000;

const CLES_MODULES = MODULES_SAAS.map((m) => m.cle);

/**
 * Traduit la liste modules_actifs d'une ligne d'abonnement en "accès" :
 * - null : aucune restriction (pas de ligne d'abonnement, ou Pack tout compris) ;
 * - { souscrits, lecture } sinon. Les clés inconnues (faute de frappe, ancien module) sont ignorées.
 * `modulesActifs === undefined/null` = pas de ligne d'abonnement.
 */
function resoudreAcces(modulesActifs) {
    if (!Array.isArray(modulesActifs)) return null;
    if (modulesActifs.includes(PACK_TOUT_COMPRIS.cle)) return null;
    const souscrits = CLES_MODULES.filter((cle) => modulesActifs.includes(cle));
    const lecture = new Set();
    for (const cle of souscrits) {
        for (const dep of MODULES_SAAS.find((m) => m.cle === cle).lecture) lecture.add(dep);
    }
    return { souscrits, lecture: [...lecture] };
}

/** `methode` = verbe HTTP : la lecture implicite (dépendances) ne vaut que pour GET/HEAD. */
function moduleAutorise(acces, cle, methode = 'GET') {
    if (acces === null) return true;
    if (acces.souscrits.includes(cle)) return true;
    return ['GET', 'HEAD'].includes(String(methode).toUpperCase()) && acces.lecture.includes(cle);
}

/** Onglets visibles : null = tous (rôle seul décide) ; sinon Socle + onglets des modules souscrits. */
function ongletsAutorises(acces) {
    if (acces === null) return null;
    const onglets = new Set(SOCLE_ESSENTIEL.onglets);
    for (const cle of acces.souscrits) {
        for (const o of MODULES_SAAS.find((m) => m.cle === cle).onglets) onglets.add(o);
    }
    return [...onglets];
}

function libelleModule(cle) {
    return MODULES_SAAS.find((m) => m.cle === cle)?.label || cle;
}

module.exports = {
    SOCLE_ESSENTIEL,
    MODULES_SAAS,
    PACK_TOUT_COMPRIS,
    FRAIS_CONFIGURATION_DEFAUT,
    resoudreAcces,
    moduleAutorise,
    ongletsAutorises,
    libelleModule,
};

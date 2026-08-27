/**
 * Catalogue de référence des modules SaaS vendables (grille tarifaire validée avec l'utilisateur,
 * 2026-08-08, révisée le 2026-08-27 pour intégrer Élevage et Paie — modules ajoutés depuis sans
 * jamais être reflétés ici). Purement indicatif — les prix réellement facturés sont négociés au cas
 * par cas et stockés directement sur organisation_abonnement_saas.montant_mensuel, jamais
 * recalculés à partir de ce catalogue. Sert à préremplir/valider les formulaires de la vue
 * plateforme (routes/plateforme.js, web/js/views/plateforme.js).
 *
 * Sécurité (mot de passe renforcé, vérification email, MFA) volontairement absente de ce
 * catalogue : incluse d'office dans le Socle Essentiel plutôt que facturée en option — la vendre
 * séparément donnerait l'impression que les non-payeurs sont moins protégés.
 */
const SOCLE_ESSENTIEL = { prixMensuelDefaut: 25000, label: 'Socle Essentiel (Production, Catalogue, Tableau de bord — inclus dans tout abonnement)' };

const MODULES_SAAS = [
    { cle: 'clients_abonnements', label: 'Clients & Abonnements', prixMensuelDefaut: 10000 },
    { cle: 'commandes_fournisseurs', label: 'Commandes & Fournisseurs', prixMensuelDefaut: 10000 },
    { cle: 'comptabilite', label: 'Comptabilité', prixMensuelDefaut: 10000 },
    { cle: 'support', label: 'Support client', prixMensuelDefaut: 5000 },
    { cle: 'logistique', label: 'Logistique', prixMensuelDefaut: 15000 },
    { cle: 'finance', label: 'Finance (encaissement PayDunya)', prixMensuelDefaut: 15000 },
    // Même palier que Logistique/Finance : suivi individuel le plus sophistiqué du catalogue
    // (généalogie, reproduction), mais pas un besoin universel (uniquement les fermes avec ruminants).
    { cle: 'elevage', label: 'Élevage (suivi individuel bovins/ovins/caprins)', prixMensuelDefaut: 15000 },
    // Même palier que Comptabilité/Clients & Abonnements : module administratif standard.
    { cle: 'paie', label: 'Paie', prixMensuelDefaut: 10000 },
];

// 85000 = ~72% de la somme à la carte (Socle 25000 + 8 modules 90000 = 115000), même taux de
// remise qu'avant l'ajout d'Élevage/Paie (65000 pour 90000 à la carte).
const PACK_TOUT_COMPRIS = { cle: 'pack_tout_compris', label: 'Pack tout compris', prixMensuelDefaut: 85000 };

const FRAIS_CONFIGURATION_DEFAUT = 75000;

module.exports = { SOCLE_ESSENTIEL, MODULES_SAAS, PACK_TOUT_COMPRIS, FRAIS_CONFIGURATION_DEFAUT };

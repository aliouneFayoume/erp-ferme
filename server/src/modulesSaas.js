/**
 * Catalogue de référence des modules SaaS vendables (grille tarifaire validée avec l'utilisateur,
 * 2026-08-08). Purement indicatif — les prix réellement facturés sont négociés au cas par cas et
 * stockés directement sur organisation_abonnement_saas.montant_mensuel, jamais recalculés à partir
 * de ce catalogue. Sert à préremplir/valider les formulaires de la vue plateforme (routes/plateforme.js,
 * web/js/views/plateforme.js).
 */
const SOCLE_ESSENTIEL = { prixMensuelDefaut: 25000, label: 'Socle Essentiel (Production, Catalogue, Tableau de bord — inclus dans tout abonnement)' };

const MODULES_SAAS = [
    { cle: 'clients_abonnements', label: 'Clients & Abonnements', prixMensuelDefaut: 10000 },
    { cle: 'commandes_fournisseurs', label: 'Commandes & Fournisseurs', prixMensuelDefaut: 10000 },
    { cle: 'comptabilite', label: 'Comptabilité', prixMensuelDefaut: 10000 },
    { cle: 'support', label: 'Support client', prixMensuelDefaut: 5000 },
    { cle: 'logistique', label: 'Logistique', prixMensuelDefaut: 15000 },
    { cle: 'finance', label: 'Finance (encaissement PayDunya)', prixMensuelDefaut: 15000 },
];

const PACK_TOUT_COMPRIS = { cle: 'pack_tout_compris', label: 'Pack tout compris', prixMensuelDefaut: 65000 };

const FRAIS_CONFIGURATION_DEFAUT = 75000;

module.exports = { SOCLE_ESSENTIEL, MODULES_SAAS, PACK_TOUT_COMPRIS, FRAIS_CONFIGURATION_DEFAUT };

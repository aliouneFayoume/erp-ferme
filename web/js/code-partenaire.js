// Code partenaire (affiliation) : nettoyage de ce qui arrive par l'URL (?ref=) ou par le champ de saisie.
// Le paramètre ?ref= vient d'un lien que n'importe qui peut fabriquer : on ne garde que [A-Z0-9_-], 40 caractères au plus, comme
// le serveur (server/src/partenaires.js). Le résultat n'est JAMAIS inséré dans du HTML : seulement dans la valeur d'un champ
// (propriété .value) ou dans une adresse passée par encodeURIComponent.
// Ce fichier est chargé comme script global par les pages (bundles de web/build.js) ET exportable en module pour les tests.
(function (racine) {
  const CODE_PARTENAIRE_MAX = 40;
  const CLE_STOCKAGE = 'massla_ref';

  function nettoyerCodePartenaire(valeur) {
    if (typeof valeur !== 'string') return '';
    return valeur.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, CODE_PARTENAIRE_MAX);
  }

  /**
   * Code du lien visité : ?ref= de l'adresse en cours, sinon celui mémorisé pendant la visite (le visiteur arrive sur /decouvrir?ref=CODE,
   * lit une page secteur, puis clique « Essayer gratuitement » : le code ne doit pas se perdre en route). sessionStorage seulement :
   * rien ne persiste après la fermeture de l'onglet. Un stockage bloqué ou absent n'empêche rien.
   */
  function codePartenaireDuLien() {
    let code = '';
    try {
      code = nettoyerCodePartenaire(new URLSearchParams(racine.location.search).get('ref'));
    } catch (e) {
      code = '';
    }
    try {
      if (code) racine.sessionStorage.setItem(CLE_STOCKAGE, code);
      else code = nettoyerCodePartenaire(racine.sessionStorage.getItem(CLE_STOCKAGE));
    } catch (e) {
      /* stockage indisponible : on se contente du lien */
    }
    return code;
  }

  const api = { nettoyerCodePartenaire, codePartenaireDuLien, CODE_PARTENAIRE_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (racine) Object.assign(racine, { MassiaCodePartenaire: api });
})(typeof window !== 'undefined' ? window : undefined);

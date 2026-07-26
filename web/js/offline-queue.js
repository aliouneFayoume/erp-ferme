/**
 * File d'attente hors-ligne pour les écritures terrain (livreurs) : preuve de livraison, encaissement
 * espèces, ouverture de caisse. En zone à connectivité faible, une action refusée par le réseau ne
 * doit jamais être perdue — elle est stockée ici et rejouée automatiquement à la reconnexion.
 * Persistée dans localStorage (survit à une fermeture de l'app entre deux zones couvertes).
 */
const OfflineQueue = (() => {
  const KEY = 'erp_offline_queue';
  const listeners = [];

  function lire() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || [];
    } catch (e) {
      return [];
    }
  }
  function ecrire(queue) {
    localStorage.setItem(KEY, JSON.stringify(queue));
    listeners.forEach((fn) => fn(queue));
  }

  function ajouter({ method, path, body, label }) {
    const queue = lire();
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      path,
      body,
      label,
      cree_le: new Date().toISOString(),
    });
    ecrire(queue);
  }

  function taille() {
    return lire().length;
  }

  function surChangement(fn) {
    listeners.push(fn);
  }

  /** Rejoue la file dans l'ordre. S'arrête au premier échec réseau (on retentera plus tard) ;
   * une erreur métier (ex. commande déjà annulée) retire l'action plutôt que de boucler dessus. */
  async function synchroniser() {
    let queue = lire();
    if (queue.length === 0) return { reussies: 0, restantes: 0 };

    let reussies = 0;
    for (const item of [...queue]) {
      try {
        await Api[item.method.toLowerCase()](item.path, item.body);
        queue = queue.filter((i) => i.id !== item.id);
        ecrire(queue);
        reussies++;
      } catch (err) {
        if (err.reseau) break; // toujours hors-ligne : on réessaiera au prochain déclenchement
        queue = queue.filter((i) => i.id !== item.id); // erreur serveur définitive : on abandonne cette action
        ecrire(queue);
      }
    }
    return { reussies, restantes: lire().length };
  }

  return { ajouter, taille, lire, surChangement, synchroniser };
})();
window.OfflineQueue = OfflineQueue;

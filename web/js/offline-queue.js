/**
 * File d'attente hors-ligne partagée pour toutes les écritures terrain (livreurs, relevés de
 * production...) : une action refusée par le réseau ne doit jamais être perdue — elle est stockée
 * ici et rejouée automatiquement à la reconnexion.
 *
 * Persistée dans IndexedDB plutôt que localStorage : chaque action est son propre enregistrement
 * (ajout/suppression individuels sans réécrire tout le tableau), et la limite de taille est de
 * plusieurs centaines de Mo au lieu des ~5-10 Mo de localStorage — important si un livreur ou un
 * chef de production accumule beaucoup d'actions sur plusieurs jours sans réseau.
 */
const OfflineQueue = (() => {
  const DB_NAME = 'erp-ferme-offline';
  const DB_VERSION = 1;
  const STORE = 'queue';
  const listeners = [];
  let dbPromise;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function lire() {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          req.onsuccess = () => resolve(req.result.sort((a, b) => a.cree_le.localeCompare(b.cree_le)));
          req.onerror = () => reject(req.error);
        })
    );
  }

  async function notifier() {
    const queue = await lire();
    listeners.forEach((fn) => fn(queue));
  }

  async function ajouter({ method, path, body, label }) {
    const db = await openDB();
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      path,
      body,
      label,
      cree_le: new Date().toISOString(),
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(item);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await notifier();
  }

  async function retirer(id) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    await notifier();
  }

  async function taille() {
    return (await lire()).length;
  }

  function surChangement(fn) {
    listeners.push(fn);
  }

  /** Rejoue la file dans l'ordre. S'arrête au premier échec réseau (on retentera plus tard) ;
   * une erreur métier (ex. commande déjà annulée) retire l'action plutôt que de boucler dessus. */
  async function synchroniser() {
    const queue = await lire();
    if (queue.length === 0) return { reussies: 0, restantes: 0 };

    let reussies = 0;
    for (const item of queue) {
      try {
        await Api[item.method.toLowerCase()](item.path, item.body);
        await retirer(item.id);
        reussies++;
      } catch (err) {
        if (err.reseau) break; // toujours hors-ligne : on réessaiera au prochain déclenchement
        await retirer(item.id); // erreur serveur définitive : on abandonne cette action
      }
    }
    return { reussies, restantes: (await lire()).length };
  }

  return { ajouter, taille, lire, surChangement, synchroniser };
})();
window.OfflineQueue = OfflineQueue;

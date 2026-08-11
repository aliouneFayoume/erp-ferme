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
  const DB_VERSION = 2;
  const STORE = 'queue';
  // Actions abandonnées après échecs répétés (5xx persistant) : jamais supprimées silencieusement,
  // conservées pour qu'un utilisateur puisse voir ce qui n'a pas pu être envoyé et prévenir le
  // support plutôt que de découvrir plus tard qu'un encaissement terrain n'existe nulle part.
  const DEAD_STORE = 'echecs';
  const MAX_TENTATIVES = 5;
  const listeners = [];
  let dbPromise;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(DEAD_STORE)) {
            db.createObjectStore(DEAD_STORE, { keyPath: 'id' });
          }
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

  function lireEchecs() {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = db.transaction(DEAD_STORE, 'readonly').objectStore(DEAD_STORE).getAll();
          req.onsuccess = () => resolve(req.result);
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

  /** Incrémente le compteur d'essais d'un item et renvoie sa nouvelle valeur (0 si l'item a
   * disparu entretemps, ex. supprimé manuellement pendant une tentative). */
  async function incrementerTentatives(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (!item) return resolve(0);
        item.tentatives = (item.tentatives || 0) + 1;
        store.put(item);
        tx.oncomplete = () => resolve(item.tentatives);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Déplace un item vers le magasin des échecs définitifs (jamais supprimé silencieusement) et le
   * retire de la file active, pour qu'un item bloqué ne fige pas la synchronisation des suivants. */
  async function declarerMorte(id, raison) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE, DEAD_STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const item = getReq.result;
        if (item) {
          tx.objectStore(DEAD_STORE).put({ ...item, echec_le: new Date().toISOString(), raison });
          store.delete(id);
        }
      };
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

  /**
   * Rejoue la file dans l'ordre. Trois familles d'échec, traitées différemment :
   * - Réseau absent (err.reseau) : on s'arrête, on retentera au prochain déclenchement. Inchangé.
   * - 401/403 (session expirée/refusée) : on s'arrête SANS supprimer l'action — un jeton expiré
   *   après 12h de tournée terrain ne doit jamais effacer un encaissement en attente. On prévient
   *   l'appelant pour qu'il invite l'utilisateur à se reconnecter.
   * - 5xx (panne serveur passagère, ex. gel pendant un déploiement) : on s'arrête SANS supprimer,
   *   mais on compte la tentative. Après MAX_TENTATIVES échecs consécutifs, l'item est déplacé vers
   *   le magasin des échecs définitifs plutôt que de bloquer indéfiniment les actions suivantes.
   * - Tout autre code (400/404/409/422... = refus métier définitif, ex. commande déjà annulée) :
   *   comportement inchangé, l'action est retirée.
   * Constat et correctif audit systèmes 2026-08-11 : la version précédente supprimait l'action sur
   * TOUTE erreur non réseau, y compris 401/403/5xx — perte silencieuse d'encaissements terrain à
   * chaque expiration de session ou pendant la fenêtre 502 de chaque déploiement.
   */
  async function synchroniser() {
    const queue = await lire();
    if (queue.length === 0) return { reussies: 0, restantes: 0, sessionExpiree: false };

    let reussies = 0;
    let sessionExpiree = false;
    for (const item of queue) {
      try {
        await Api[item.method.toLowerCase()](item.path, item.body);
        await retirer(item.id);
        reussies++;
      } catch (err) {
        if (err.reseau) break; // toujours hors-ligne : on réessaiera au prochain déclenchement
        if (err.statut === 401 || err.statut === 403) {
          sessionExpiree = true;
          break; // session expirée : on garde l'action, on ne peut rien envoyer tant que non reconnecté
        }
        if (err.statut >= 500) {
          const tentatives = await incrementerTentatives(item.id);
          if (tentatives >= MAX_TENTATIVES) {
            await declarerMorte(item.id, `Échec serveur répété (${tentatives} tentatives) : ${err.message}`);
            continue; // celle-ci est écartée, mais on continue avec les actions suivantes
          }
          break; // panne serveur passagère : on retentera plus tard, sans bloquer sur un compteur épuisé
        }
        await retirer(item.id); // refus métier définitif (400/404/409/422...) : on abandonne cette action
      }
    }
    return { reussies, restantes: (await lire()).length, sessionExpiree };
  }

  return { ajouter, taille, lire, lireEchecs, surChangement, synchroniser };
})();
window.OfflineQueue = OfflineQueue;

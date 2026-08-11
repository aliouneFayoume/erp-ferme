# Audit Systèmes & Infrastructure — ERP Ferme (Massla)

**Date :** 2026-08-11
**Périmètre :** lecture seule. Aucun fichier n'a été modifié.

---

## 1. Résumé exécutif

La maturité opérationnelle est **nettement au-dessus de la moyenne pour un projet solo** : CI/CD automatisé avec porte de tests, sauvegardes externalisées toutes les 6h vers Cloudflare R2 avec alerte sur échec, wildcard TLS renouvelé par DNS-01 automatisé, base déportée sur un service managé (Supabase) — ce qui retire au VPS son rôle de dépositaire de données. Les choix sont pragmatiques et bien documentés (`deploy/DEPLOIEMENT.md` est un vrai runbook, rare à ce stade).

Trois angles morts, en revanche, sont structurels et non des détails de finition. **(a)** La clé `CREDENTIALS_ENCRYPTION_KEY` qui chiffre les identifiants PayDunya/WhatsApp de tous les tenants n'existe qu'en un seul exemplaire, dans un fichier jamais sauvegardé, sur le VPS : la perte du VPS rend les moyens de paiement de toutes les fermes définitivement indéchiffrables — une sauvegarde de base parfaite n'y changerait rien. **(b)** Aucune restauration n'a jamais été testée, et le dump actuel ne contient pas le rôle applicatif `erp_app` dont dépend l'efficacité du RLS : une restauration réussie techniquement pourrait produire une base où l'isolation multi-tenant ne filtre plus. **(c)** L'architecture applicative impose un plafond dur d'environ 10 requêtes authentifiées simultanées, et un appel PayDunya lent gèle l'application pour toutes les fermes.

Le mode hors-ligne, enfin, **supprime silencieusement les actions terrain** dès que le serveur répond autre chose qu'une erreur réseau — y compris pendant chaque déploiement.

Verdict : les fondations tiennent pour 1 à 5 fermes. Les points ci-dessous doivent être traités avant de passer à 15-20, et deux d'entre eux (a, c) sont des risques réels dès aujourd'hui.

> **Note de suivi (2026-08-11, même session) :** C3 (perte de données hors ligne) et C1 (partiel —
> chiffrement des secrets dans `backup.sh`) ont été corrigés le jour même. Voir
> [00-synthese.md](00-synthese.md).

---

## 2. Constats

### 🔴 CRITIQUE

---

**C1 — La clé de chiffrement des identifiants de paiement n'est sauvegardée nulle part**

*Constat.* `server/src/credentials.js` dérive la clé AES-256-GCM depuis `process.env.CREDENTIALS_ENCRYPTION_KEY`. Cette variable vit uniquement dans `/home/ubuntu/erp-ferme/server/.env` sur le VPS. Ce fichier est exclu de git (`.gitignore`), exclu de l'image Docker (`.dockerignore`), et `deploy/backup.sh` ne sauvegarde que la base (`pg_dump`). Aucun chemin ne le duplique hors du VPS.

*Pourquoi c'est important.* Scénario concret : le VPS OCI est perdu (suppression accidentelle, réclamation d'instance, compromission qui force un rebuild à neuf). Vous restaurez la base Supabase sans problème. Mais `organisation_paydunya_config` et `organisation_whatsapp_config` ne contiennent que des blobs base64 que plus rien au monde ne peut déchiffrer. Chaque ferme cliente doit re-saisir ses clés d'agrégateur PayDunya — celles-là mêmes qu'un exploitant agricole a mis des semaines à obtenir et ne sait généralement pas retrouver. C'est un incident dont on ne se remet pas commercialement. Même remarque, moins grave, pour `JWT_SECRET` (perte = déconnexion de tous) et `deploy/certbot/ovh.ini` (perte = re-création du jeton API OVH sous pression, avec le certificat qui expire).

*Recommandation.* Sortir les secrets du VPS comme source unique. Le minimum viable, ce soir : `age` ou `gpg --symmetric` sur `server/.env` + `deploy/certbot/ovh.ini`, avec la passphrase dans votre gestionnaire de mots de passe personnel, et le fichier chiffré déposé dans le bucket R2 existant (ajouter 3 lignes à `backup.sh`). Le mieux, ensuite : un coffre externe (Bitwarden/1Password, ou même une note chiffrée hors ligne conservée physiquement) contenant les 4 valeurs irremplaçables, et une ligne dans `DEPLOIEMENT.md` disant où les retrouver.

---

**C2 — Aucune restauration n'a jamais été testée, et le dump actuel est incomplet pour une restauration fidèle**

*Constat.* `deploy/backup.sh` fait un `pg_dump --format=custom` de la base et un `rclone sync` vers R2. Il n'existe aucune procédure de restauration dans `deploy/DEPLOIEMENT.md`, aucun script de vérification (pas même un `pg_restore --list` pour prouver que le fichier n'est pas tronqué), et aucune trace d'un essai. Techniquement, deux manques précis :
- `pg_dump` d'une base **n'inclut pas les rôles** (objets globaux du cluster). Le rôle `erp_app` défini dans `server/src/provision-role.sql` — dont dépend toute l'efficacité de RLS, puisqu'un propriétaire de table contourne les policies (aucun `FORCE ROW LEVEL SECURITY` dans `server/src/rls-policies.sql`) — n'existerait pas dans une base restaurée. Les `CREATE POLICY ... TO erp_app` échoueraient à la restauration.
- Les politiques RLS n'étant pas dans `server/src/schema.sql` (0 occurrence de `POLICY`) mais dans `rls-policies.sql` appliqué séparément, une reconstruction « à la main » depuis le schéma produit une base sans aucune isolation.

*Pourquoi c'est important.* Scénario concret : incident sur le projet Supabase un mardi matin. Vous récupérez le dernier `.dump` depuis R2, vous le restaurez dans un projet neuf, l'application ne démarre pas (rôle inexistant). Vous corrigez en pointant `DATABASE_URL` sur le rôle propriétaire pour « aller vite » — l'application redémarre, tout semble fonctionner, **et RLS ne filtre plus rien**. Chaque ferme voit alors les clients et les commandes des autres, sans le moindre message d'erreur. Le pire scénario n'est pas l'échec de la restauration, c'est sa réussite apparente.

*Recommandation.* Une répétition de restauration, une fois, chronométrée, dans un projet Supabase jetable (plan gratuit) — et le runbook écrit à ce moment-là dans `DEPLOIEMENT.md` : télécharger depuis R2, `psql -f provision-role.sql`, `pg_restore`, `node src/apply-rls.js`, `node src/verify-rls.js` (vous avez déjà cet outil de vérification, il est excellent : c'est votre critère de succès de restauration). Ajouter `pg_dumpall --globals-only --roles-only` à `backup.sh`, et un `pg_restore --list "$FICHIER" > /dev/null` juste après le dump pour ne pas envoyer un fichier tronqué chez R2. Refaire l'exercice tous les 6 mois. Objectif à afficher : RTO 2h, RPO 6h.

---

**C3 — Le mode hors-ligne détruit silencieusement les actions terrain sur toute erreur non-réseau**

*Constat.* Dans `web/js/offline-queue.js`, fonction `synchroniser()` :
```js
} catch (err) {
  if (err.reseau) break;      // toujours hors-ligne : on réessaiera
  await retirer(item.id);     // erreur serveur définitive : on abandonne cette action
}
```
Or `err.reseau` n'est posé (dans `web/js/api.js`) **que** lorsque `fetch()` lui-même rejette. Toute réponse HTTP d'erreur — 401, 403, 500, 502, 504 — tombe dans la branche « on abandonne », qui supprime définitivement l'enregistrement IndexedDB, sans notification à l'utilisateur, sans journal, sans corbeille. Le badge de synchronisation redescend simplement à zéro.

*Pourquoi c'est important.* Trois scénarios concrets, tous plausibles cette semaine :
1. Un livreur part en tournée à 7h, réseau absent toute la journée, 14 preuves de livraison et encaissements en file. Le token staff dure **12h** (`signToken`, `expiresIn: '12h'`). Il rentre à 19h30, retrouve la 4G : les 14 requêtes prennent un `401 Session invalide ou expirée`, et les 14 sont effacées. Il voit « tout est synchronisé ». Ce sont des encaissements en espèces, donc de l'argent réel, qui n'existent plus nulle part.
2. `tenterSyncHorsLigne()` tourne **toutes les 30 secondes** (`web/js/app.js`, `setInterval`). Pendant un déploiement, `docker compose up -d --build` recrée le conteneur app tandis que nginx reste debout et renvoie des **502** : toute file en attente sur n'importe quel appareil, à cet instant, est purgée. Chaque déploiement est une fenêtre de destruction de données.
3. Un bug serveur renvoyant 500 sur une route consomme la file au lieu de la préserver le temps du correctif.

*Recommandation.* Trois changements, tous locaux à `offline-queue.js` :
- Ne retirer l'action que sur un `4xx` métier explicitement identifié (400/409/422). Sur 401/403 : **arrêter** la boucle (comme pour le réseau) et déclencher une invite de reconnexion. Sur 5xx : arrêter la boucle, réessayer plus tard, avec compteur de tentatives.
- Après N tentatives, déplacer l'élément dans un store `dead-letter` d'IndexedDB, et l'afficher à l'utilisateur (« 3 actions n'ont pas pu être envoyées ») plutôt que de le supprimer.
- Ajouter une clé d'idempotence : `item.id` existe déjà, l'envoyer en en-tête `Idempotency-Key` et le stocker côté serveur. Sans cela, le cas symétrique existe aussi : une écriture qui réussit côté serveur mais dont la réponse se perd (coupure 4G au mauvais moment) rejette `fetch`, donc `err.reseau`, donc `break`, donc l'élément reste en file et sera **rejoué** — encaissement compté deux fois.

---

### 🟠 ÉLEVÉ

---

**E1 — Plafond dur d'environ 10 requêtes simultanées, avec appels externes tenus sur la connexion base**

*Constat.* `server/src/db.js` : `new Pool({ connectionString })` — aucun paramètre, donc `max: 10` (défaut `node-postgres`), `connectionTimeoutMillis: 0` (attente **infinie**), aucun `statement_timeout`. Et `server/src/auth.js`, `attachTenantConnection()` : chaque requête authentifiée fait `pool.connect()` et ne relâche la connexion qu'à l'événement `finish`/`close` de la réponse — la connexion est donc immobilisée pendant **toute** la durée du traitement HTTP. Or ce traitement inclut des appels réseau sortants sans aucun délai maximal : `server/src/paydunya.js` (`creerFacture`, `confirmerFacture`), `server/src/whatsapp.js` (`envoyerMessageWhatsapp`), `server/src/routing.js` (`matriceReelle` vers OpenRouteService) — tous en `fetch()` nu, sans `AbortSignal.timeout()`. `routes/finance.js` appelle bien `creerFacture` entre deux `req.db.query`.

*Pourquoi c'est important.* Scénario concret : PayDunya ralentit un après-midi (leurs API répondent en 30s au lieu de 300ms). Dix clients cliquent « Payer » dans dix fermes différentes. Les dix connexions du pool sont bloquées. La onzième requête — n'importe laquelle, une simple consultation du tableau de bord d'une autre ferme — attend **indéfiniment** puisque `connectionTimeoutMillis` vaut 0. Toutes les fermes voient l'application figée. Rien ne plante, donc `monitor.sh` reste muet et les journaux ne montrent aucune erreur. C'est le mode de panne le plus difficile à diagnostiquer qui soit, et il ne demande pas beaucoup de fermes pour se produire.

*Recommandation.* Quatre lignes dans `db.js` :
```js
new Pool({ connectionString, max: 20, connectionTimeoutMillis: 5000,
           idleTimeoutMillis: 30000, statement_timeout: 15000 })
```
`connectionTimeoutMillis` transforme un gel silencieux en erreur 503 visible et alertable. Puis, plus important : ajouter `signal: AbortSignal.timeout(10000)` à chaque `fetch()` sortant, et restructurer `routes/finance.js` pour **relâcher la connexion avant** l'appel PayDunya (lire les données, `release`, appeler PayDunya, reprendre une connexion pour écrire). Vérifier au passage le plafond de connexions du plan Supabase : le pooler en mode session (port 5432, cf. `README.md`) consomme une connexion serveur par connexion cliente — `max: 20` × nombre d'instances doit rester sous ce plafond.

---

**E2 — `/api/health` ne teste pas la base : la supervision est verte pendant une panne de base**

*Constat.* `server/src/index.js` : `app.get('/api/health', ...)` renvoie un objet statique (`statut: 'En ligne'`) sans jamais toucher `pool`. C'est cette URL exacte que sondent `deploy/monitor.sh` **et** l'étape de vérification post-déploiement de `.github/workflows/deploy.yml`.

*Pourquoi c'est important.* Si Supabase est indisponible, si le mot de passe de `erp_app` est rejeté, ou si le pool est épuisé (cf. E1), l'application continue de répondre 200 sur `/api/health` alors que **chaque écran métier renvoie une erreur**. Aucune alerte ntfy ne part. Pire : le pipeline de déploiement conclut « OK : l'application répond » et considère la mise en production réussie alors que rien ne fonctionne. Vous l'apprenez par un appel téléphonique d'un client.

*Recommandation.* Faire du health check une vraie sonde : `SELECT 1` avec un délai maximal court, plus le nombre de connexions libres du pool, plus le SHA du commit déployé (via un `ARG`/`ENV` posé au build Docker). Renvoyer 503 si la base ne répond pas. Cela rend `monitor.sh` réellement utile et donne au pipeline une vérification qui distingue « le nouveau code tourne » de « un processus écoute sur le port 4000 ».

> **Note de suivi (2026-08-11) :** `/api/health` interroge désormais réellement la base (`SELECT 1`)
> et renvoie 503 si elle est injoignable — corrigé le jour même.

---

**E3 — Supervision autohébergée, fenêtre de détection de 2h, aucun garde-fou sur les sauvegardes ni sur l'expiration du certificat**

*Constat.* `deploy/erp-ferme-monitor.timer` : `OnCalendar=*-*-* 00/2:00:00`, soit un contrôle toutes les 2h, exécuté **depuis le VPS lui-même** (limite honnêtement documentée dans `DEPLOIEMENT.md`). Les alertes reposent entièrement sur des `trap ERR` : `backup.sh` et `certbot-renew.sh` n'alertent que s'ils **s'exécutent et échouent**. Ils n'alertent jamais s'ils ne s'exécutent pas du tout (timer masqué après une manipulation systemd, VPS redémarré sans `systemctl enable`, migration de machine où l'on oublie de recopier les units — cas d'autant plus probable que ces units ne sont pas installées par le déploiement, mais copiées à la main). Aucune vérification de la date d'expiration réelle du certificat, ni de la fraîcheur du dernier fichier présent dans R2, ni de l'espace disque.

*Pourquoi c'est important.* Trois pannes silencieuses concrètes. **(1)** Le VPS tombe entièrement à 22h un vendredi ; le contrôle ne s'exécute pas, donc aucune alerte n'est jamais envoyée, et vous découvrez la panne lundi matin. **(2)** Le timer de sauvegarde a été désactivé lors d'une manipulation il y a six semaines ; aucune alerte, parce que « échec de sauvegarde » et « aucune sauvegarde » sont deux choses différentes ; vous vous en apercevez le jour où vous avez besoin d'un dump. **(3)** `ovh.ini` a été effacé lors d'un nettoyage ; le renouvellement échoue et alerte — mais si l'alerte passe inaperçue, le certificat **wildcard** expire, et ce sont **toutes** les fermes, chacune sur son sous-domaine, qui affichent un écran rouge d'avertissement de sécurité au même instant.

*Recommandation.* À votre échelle, deux services gratuits suffisent et remplacent tout le reste :
- **UptimeRobot** ou **Better Stack** (gratuit) sonde `https://massla.sn/api/health` depuis l'extérieur toutes les 5 minutes. Cela couvre la panne totale du VPS, réduit le délai de détection de 2h à 5 min, et surveille aussi l'expiration TLS automatiquement (l'angle mort de C3 pour le certificat disparaît).
- **Healthchecks.io** (gratuit) en interrupteur d'homme mort : `backup.sh` termine par un `curl` vers une URL de ping ; si le ping n'arrive pas dans les 7 heures, Healthchecks vous alerte. C'est le seul mécanisme qui détecte une sauvegarde qui **ne tourne plus**. Trois lignes à ajouter, gain disproportionné.
- Ajouter à `monitor.sh` un contrôle de disque (`df`) et un contrôle du nombre de jours restants sur le certificat.

---

**E4 — Migrations manuelles, hors du pipeline, sans registre de ce qui a été appliqué**

*Constat.* Neuf fichiers `server/src/migration-0N-*.sql`, appliqués « une fois via le SQL Editor Supabase » (`README.md`, `DEPLOIEMENT.md`). Aucune table de suivi (`schema_migrations`), aucun exécuteur (`migrate.js` ne sait que rejouer `schema.sql` en entier, réservé à une base vierge), aucune étape dans `.github/workflows/deploy.yml`. La seule protection est la discipline : les fichiers sont écrits en `IF NOT EXISTS` et sont donc rejouables. Le schéma est maintenu **en double** — chaque évolution doit être écrite à la fois dans `schema.sql` (source des tests pg-mem et des bases neuves) et dans un `migration-NN.sql` (production).

*Pourquoi c'est important.* Le déploiement est automatique sur `main`, la migration ne l'est pas. Il suffit d'un merge un soir de fatigue pour que du code référençant une colonne inexistante parte en production pendant que le SQL attend encore dans l'onglet Supabase : erreurs 500 sur toutes les fermes, sans que rien n'ait « échoué » dans la CI. Second risque, plus insidieux : la double maintenance finit toujours par diverger. Le jour où `schema.sql` et la production ne correspondent plus, vos tests valident un schéma que la production n'a pas — et votre base restaurée (C2) ne correspondra pas non plus.

*Recommandation.* Vous n'avez pas besoin d'un outil lourd. Une table `schema_migrations (fichier TEXT PRIMARY KEY, applique_le TIMESTAMPTZ)` et 30 lignes dans `migrate.js` pour parcourir `migration-*.sql` par ordre alphabétique, sauter ce qui est déjà enregistré, exécuter le reste dans une transaction. Ensuite, une étape dans `deploy.yml` **avant** le rebuild : `node src/migrate.js --pending`. Vous gagnez l'ordre garanti, l'exactement-une-fois, la traçabilité, et la reproductibilité pour la restauration. Bonus : générer `schema.sql` depuis une base fraîchement migrée (`pg_dump --schema-only`) plutôt que de le maintenir à la main supprime la divergence à la racine.

---

**E5 — Aucun retour arrière rapide : le déploiement détruit l'image précédente**

*Constat.* `.github/workflows/deploy.yml` : `git reset --hard origin/main && docker compose up -d --build`, puis `docker image prune -f` en cas de succès. La construction de l'image a lieu **sur le VPS de production**. Le `prune` supprime les images sans étiquette — donc précisément l'image N-1 qui vient d'être détitrée par le nouveau build. `Dockerfile` utilise par ailleurs `npm install --omit=dev` alors que `package-lock.json` est copié : `npm ci` serait le choix correct.

*Pourquoi c'est important.* Un déploiement introduit une régression à 16h. Le retour arrière consiste à faire un `git reset` sur le commit précédent et à **reconstruire** (`npm install`, plusieurs minutes, sur une machine dont le CPU est déjà utilisé pour servir le trafic), sans garantie d'obtenir le même artefact — `npm install` peut résoudre des dépendances transitives différentes de celles testées en CI. Avec une image N-1 conservée, le retour arrière serait un `docker compose up -d` de 5 secondes. De plus, la reconstruction sur l'hôte de production consomme CPU et RAM en pleine journée, et une VM OCI modeste peut y passer en OOM — un déploiement raté peut donc aussi provoquer une panne. Enfin, cette fenêtre de redémarrage est celle où nginx renvoie des 502, ce qui déclenche C3.

*Recommandation.* Construire l'image dans GitHub Actions, la pousser sur `ghcr.io` (gratuit pour un dépôt privé) étiquetée avec le SHA du commit ; le VPS ne fait plus qu'un `docker compose pull && up -d`. Le retour arrière devient « redéployer le tag précédent ». Remplacer `npm install` par `npm ci`. Retirer le `docker image prune -f` inconditionnel (ou le remplacer par `prune --filter until=168h`). Ajouter un `healthcheck` dans `docker-compose.yml` sur le service `app` pour que Docker ne bascule le trafic qu'une fois l'application réellement prête.

---

### 🟡 MOYEN

---

**M1 — Observabilité : `console.log`, journaux non pivotés, effacés à chaque déploiement**

*Constat.* 56 appels `console.log`/`console.error` dans `server/src/routes/`, en texte libre, sans identifiant de requête, sans `tenant_id`, sans niveau. `docker-compose.yml` ne définit aucune option de journalisation : le pilote par défaut `json-file` est **sans limite de taille**. Et surtout : `docker compose up -d --build` **recrée** le conteneur, ce qui supprime son fichier de journal.

*Pourquoi c'est important.* Deux conséquences. D'abord, le disque : sur une VM au volume d'amorçage modeste, des journaux non pivotés finissent par le remplir — et un disque plein arrête Docker, nginx et les sauvegardes d'un coup, à un moment imprévisible. Ensuite, l'enquête : un client signale un problème survenu avant-hier ; s'il y a eu un déploiement entre-temps, les journaux correspondants n'existent plus. Et même présents, `console.error(err)` sans tenant ni corrélation ne permet pas de répondre à « quelle ferme, quel utilisateur, quelle requête ».

*Recommandation.* Immédiat et gratuit : `logging: { driver: "json-file", options: { max-size: "10m", max-file: "5" } }` sur les deux services de `docker-compose.yml` (supprime le risque de saturation disque). Ensuite, `pino` en remplacement de `console` (une demi-journée) avec un middleware qui pose `req.id` et journalise `tenant_id`, `user_id`, route, statut, durée en JSON — cela rend `grep` réellement exploitable. Enfin, **Sentry** en offre gratuite pour les exceptions serveur *et* les erreurs JavaScript du navigateur : c'est ce qui vous fera découvrir les bugs terrain avant que le client n'appelle, particulièrement précieux pour une PWA hors ligne dont vous ne voyez jamais l'écran.

---

**M2 — VPS unique : point de défaillance unique pour toutes les fermes (mais la donnée, elle, est ailleurs)**

*Constat.* Une seule instance OCI (`40.233.98.20`) héberge nginx + l'application pour l'ensemble des tenants. La base est chez Supabase, donc **le VPS ne détient aucune donnée métier** — c'est le bon choix, et il change radicalement le profil de risque. Ce que le VPS détient d'irremplaçable : `server/.env` (cf. C1) et `deploy/certbot/`.

*Pourquoi c'est important.* Un incident sur cette machine met hors service toutes les fermes clientes simultanément. Mais parce que l'application est sans état, la reconstruction est mécanique : provisionner une VM, installer Docker, cloner, restaurer `.env`, `docker compose up`, repointer le DNS. Le temps de rétablissement réel dépend presque entièrement de deux facteurs : disposez-vous des secrets (aujourd'hui : non — C1), et la procédure est-elle écrite (aujourd'hui : partiellement). Le TTL DNS chez OVH est le dernier maillon.

*Recommandation.* Ne construisez pas de haute disponibilité — ce serait disproportionné et cela vous coûterait plus en complexité qu'en fiabilité gagnée. Faites plutôt trois choses bon marché : (1) résoudre C1, ce qui à lui seul fait passer le RTO de « impossible » à « 2 heures » ; (2) écrire dans `DEPLOIEMENT.md` un runbook « reconstruction complète » et le chronométrer une fois — vous avez déjà 90 % de la matière ; (3) abaisser le TTL DNS de `massla.sn` et `*.massla.sn` à 300s pour que la bascule d'IP soit effective en minutes. La haute disponibilité deviendra pertinente vers 20-30 fermes, et prendra alors la forme d'une seconde instance derrière un équilibreur — l'application étant sans état, cela ne demandera aucune réécriture, à condition de résoudre E1 d'abord.

---

**M3 — Tests exécutés uniquement sur pg-mem : RLS et migrations ne sont jamais vérifiés en CI**

*Constat.* `server/tests/helpers/testApp.js` construit systématiquement une base `pg-mem` en mémoire. Or `server/src/db.js` documente lui-même que pg-mem ne connaît ni `current_setting` ni `set_config` (simulés par des stubs) et n'applique **aucune** policy RLS. La vérification réelle existe et est de bonne qualité — `server/src/verify-rls.js`, 19 Ko — mais elle se lance à la main contre une vraie base. Elle n'est dans aucun workflow. Les fichiers `migration-NN.sql` ne sont exercés par aucun test.

*Pourquoi c'est important.* Le mécanisme de sécurité central du produit — l'isolation entre fermes clientes — n'a aucun filet automatique. Une policy oubliée sur une nouvelle table, un `GRANT` manquant, et rien ne le signale avant la production. L'incident déjà consigné dans `auth.js` (contexte tenant résiduel constaté le 2026-08-09, corrigé par `queryPreTenant`) illustre exactement la classe de problèmes que pg-mem ne peut structurellement pas attraper : le commentaire dit lui-même « jamais visible via pg-mem ».

*Recommandation.* Ajouter un service `postgres:17` à `.github/workflows/ci.yml` (deux lignes, GitHub Actions le gère nativement), et un job qui applique `schema.sql` + `provision-role.sql` + `rls-policies.sql` puis exécute `verify-rls.js`. Vous avez déjà écrit l'outil ; il ne manque que la prise de courant. À terme, faire tourner l'ensemble de la suite contre du vrai Postgres et garder pg-mem uniquement pour le confort de développement local.

---

**M4 — nginx minimal : ni HTTP/2, ni compression, ni délais maximaux, ni cache statique**

*Constat.* `deploy/nginx.conf` : `listen 443 ssl;` sans `http2`, aucun `gzip`, aucun `proxy_read_timeout`/`proxy_connect_timeout`, aucun `client_max_body_size`, aucun `expires`/`Cache-Control` sur les ressources statiques.

*Pourquoi c'est important.* Votre public utilise l'application sur réseau mobile sénégalais, souvent dégradé. HTTP/2 et gzip ne sont pas du raffinement dans ce contexte : l'app shell fait une vingtaine de fichiers JavaScript (voir la liste `APP_SHELL` de `web/sw.js`), chacun demandant un aller-retour en HTTP/1.1. Activer `http2` et `gzip` est une amélioration mesurable du premier chargement, pour deux lignes. Par ailleurs, l'absence de délai maximal côté proxy signifie qu'une requête bloquée par E1 reste ouverte indéfiniment aussi côté nginx, consommant des connexions au lieu d'échouer proprement.

*Recommandation.* `listen 443 ssl http2;`, un bloc `gzip on;` sur les types texte/JS/CSS/JSON, `proxy_read_timeout 30s; proxy_connect_timeout 5s;`, `client_max_body_size 10m;`. Point à vérifier séparément : l'adresse `40.233.98.20` suggère une région OCI nord-américaine, ce qui ajoute 150-250 ms d'aller-retour pour des utilisateurs sénégalais. Si c'est le cas, une région européenne (Marseille, Francfort, Madrid) diviserait cette latence par deux ou trois — ce serait le gain de performance le plus important du lot, pour un coût de migration modeste tant que l'infrastructure reste une seule machine sans état.

---

**M5 — Quotas et paramètres tiers partagés entre tous les tenants**

*Constat.* `server/src/routing.js` : `FARM_DEPOT` est codé en dur sur les coordonnées de Diamniadio (le dépôt de Massla), et `ORS_API_KEY` est une clé globale lue dans `process.env`. Idem pour `PUBLIC_URL` dans `paydunya.js`, utilisé pour construire les URL de rappel IPN.

*Pourquoi c'est important.* Deux effets de bord multi-tenant. D'abord, l'optimisation de tournée de toute nouvelle ferme part du dépôt de Massla — résultats faux dès la deuxième ferme, à des centaines de kilomètres. Ensuite, le quota OpenRouteService (2000 requêtes/jour en offre gratuite) est **partagé** : une ferme un peu active épuise le quota et prive toutes les autres de l'optimisation, sans message d'erreur explicite pour l'utilisateur final.

*Recommandation.* Déplacer les coordonnées du dépôt en colonnes sur `organisations` (migration additive, avec les valeurs actuelles en repli pour Massla). Pour ORS : surveiller la consommation et prévoir soit une clé par ferme sur le modèle déjà en place pour PayDunya et WhatsApp (`organisation_paydunya_config`, `organisation_whatsapp_config` — le patron existe et fonctionne), soit un plafond par tenant côté application.

---

### 🟢 FAIBLE

- **F1 — `deploy/purge-donnees-sauf-utilisateurs.sql` est une arme chargée dans le dépôt.** Un `TRUNCATE ... CASCADE` sur 21 tables métier, sans clause `WHERE tenant_id = ...`, donc **tous tenants confondus**. Les avertissements en tête de fichier sont clairs, mais le fichier est versionné à côté des scripts d'exploitation courants et un copier-coller malheureux dans l'éditeur SQL Supabase efface la production de toutes les fermes. Le déplacer dans un sous-dossier `deploy/outils-dangereux/`, ou au minimum le préfixer d'un `\echo` + `ROLLBACK;` volontairement placé pour forcer une édition consciente.

- **F2 — La duplication `Dockerfile`/`erp-ferme.service` peut induire en erreur.** `deploy/erp-ferme.service` décrit un déploiement systemd direct (`/opt/erp-ferme`, utilisateur `erpferme`) qui n'est pas celui utilisé (Docker, `/home/ubuntu/erp-ferme`). C'est documenté comme « Option B », mais en incident nocturne c'est une source de confusion. Une ligne « NON UTILISÉ EN PRODUCTION » en tête du fichier `.service` suffirait.

- **F3 — Les units systemd ne sont pas déployées par le pipeline.** Les timers de sauvegarde, de supervision et de renouvellement sont copiés à la main (`sudo cp`) lors de l'installation. Modifier `backup.sh` est propagé par `git reset --hard` ; modifier `erp-ferme-backup.timer` ne l'est pas. Une divergence entre le dépôt et `/etc/systemd/system/` est probable à moyen terme, et invisible. Un `make install-units` ou quelques lignes dans le script de déploiement lèveraient l'ambiguïté.

- **F4 — Le jeton API OVH est de validité « Unlimited ».** Pratique, et cohérent avec l'automatisation. Mais un jeton permanent capable de modifier la zone DNS de `massla.sn` est aussi la clé qui permettrait d'émettre un certificat pour n'importe lequel de vos sous-domaines. `ovh.ini` est en 600 et hors git — c'est correct. À surveiller : il est nécessairement lisible par l'utilisateur `ubuntu` qui est aussi celui du déploiement SSH ; à noter dans le périmètre d'impact d'une compromission.

- **F5 — Rétention de 14 jours seulement, en miroir strict.** `backup.sh` utilise `rclone sync` (et non `copy`), ce qui propage volontairement les suppressions vers R2 — choix assumé et bien expliqué. Conséquence : une corruption de données découverte au bout de trois semaines (erreur de saisie comptable, bug de calcul de solde) n'est plus récupérable, et une suppression accidentelle **côté R2** n'a aucun filet. Envisager, quand le volume le permettra, une conservation mensuelle sur 12 mois (quelques dumps supplémentaires, coût négligeable chez R2) et l'activation du versionnage d'objets sur le bucket.

---

## 3. Les 5 actions à traiter en premier

| # | Action | Traite | Effort | Ce que ça change |
|---|---|---|---|---|
| **1** | **Sauvegarder les secrets hors du VPS** : chiffrer `server/.env` + `deploy/certbot/ovh.ini` et les pousser vers R2 dans `backup.sh` ; consigner `CREDENTIALS_ENCRYPTION_KEY` et `JWT_SECRET` dans un coffre personnel. | C1 | **1 heure** | Fait passer la perte du VPS de « catastrophe commerciale irréversible » à « 2 heures de reconstruction ». Meilleur rapport gain/effort du rapport. |
| **2** | **Corriger la perte de données hors ligne** dans `web/js/offline-queue.js` : ne plus supprimer sur 401/403/5xx, ajouter un store de rebut visible, et une clé d'idempotence sur les rejeux. | C3 | **0,5 jour** | Arrête une destruction d'encaissements en cours, qui se produit à chaque déploiement et à chaque expiration de token en tournée. |
| **3** | **Régler le pool et les délais réseau** : `max`, `connectionTimeoutMillis`, `statement_timeout` dans `server/src/db.js` ; `AbortSignal.timeout()` sur tous les `fetch()` sortants ; relâcher la connexion avant l'appel PayDunya dans `routes/finance.js`. | E1 | **0,5 jour** | Supprime le mode de panne « application figée pour toutes les fermes, sans erreur dans les journaux » — celui que vous ne diagnostiquerez pas à chaud. |
| **4** | **Supervision externe + interrupteur d'homme mort + sonde de base** : UptimeRobot sur `/api/health`, ping Healthchecks.io en fin de `backup.sh`, et `/api/health` qui interroge réellement la base. | E2, E3 | **2 heures** | Vous apprenez les pannes en 5 minutes au lieu de 2 heures (ou du lundi matin), et vous détectez enfin une sauvegarde qui **ne tourne plus**. |
| **5** | **Une répétition de restauration, chronométrée**, dans un projet Supabase jetable, avec `verify-rls.js` comme critère de réussite ; ajouter `pg_dumpall --globals-only` et `pg_restore --list` à `backup.sh` ; écrire le runbook. | C2 | **0,5 jour** | Transforme 14 jours de fichiers `.dump` en une capacité de restauration réellement prouvée — et écarte le pire scénario : une restauration réussie où RLS ne filtre plus. |

Les actions 1 à 4 tiennent en une journée et demie cumulée et couvrent tous les risques critiques immédiats. L'action 5 mérite une demi-journée dédiée, à froid. Ensuite seulement viennent E4 (registre de migrations) et E5 (registre d'images pour le retour arrière), qui sont les deux investissements qui rendront la croissance à 15-20 fermes sereine.

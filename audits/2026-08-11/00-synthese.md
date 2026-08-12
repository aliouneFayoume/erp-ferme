# Synthèse — Comité d'audit ERP Ferme (2026-08-11)

*Mise à jour le 2026-08-11 (même jour) : les 6 correctifs "cette semaine" sont déployés en
production, ainsi qu'un incident critique découvert en cours de route (sauvegardes cassées depuis
77h). Voir la section "État d'avancement" ci-dessous.*

Trois experts (sécurité, systèmes/infrastructure, développement), chacun avec plus de 20 ans
d'expérience, ont audité indépendamment le code et l'infrastructure d'ERP Ferme, sans se
concerter. Rapports complets (chacun annoté des correctifs appliqués depuis) :

- [01-securite.md](01-securite.md)
- [02-systemes-infra.md](02-systemes-infra.md)
- [03-developpement.md](03-developpement.md)

## Constat le plus important : la convergence

Les trois experts, travaillant indépendamment, ont chacun mis le doigt sur les mêmes failles à
des endroits différents — le signal le plus fiable d'un audit de ce type :

- **Sécurité ET Développement** ont chacun trouvé, séparément, que **l'absence totale de gestion
  d'erreur async peut faire tomber tout le serveur** (toutes les fermes coupées). Le dev l'a
  reproduit empiriquement, la sécurité a trouvé une requête HTTP précise, sans compte, qui
  déclenche le crash.
- **Sécurité ET Développement** ont chacun trouvé que **`POST /api/clients/:id/pin` était cassé
  en production** (verrouille le client hors de son portail) et que c'était la seule route
  d'écriture sans filtre `tenant_id`.
- **Sécurité, Systèmes ET Développement** pointent tous les trois **le même trou structurel** :
  `pg-mem` (utilisé dans les tests) ne peut pas simuler les policies RLS — la garantie la plus
  critique du produit (l'étanchéité entre fermes) n'avait aucun filet automatique, seulement
  `verify-rls.js` lancé à la main. Les 3 pannes de production des semaines précédentes (login
  staff, création de ferme, réglages PayDunya) ont exactement cette signature. **Corrigé** (item #7
  ci-dessous) : c'était le dernier constat encore classé critique dans les trois rapports.
- **Sécurité ET Développement** ont trouvé, indépendamment, **les deux mêmes lignes de code non
  échappées** (XSS) dans le frontend.

## État d'avancement

### ✅ Déployés en production (2026-08-11)

Les 6 actions "cette semaine", testées (188/188 tests passent) et déployées :

1. **Filet d'erreur global** — `express-async-errors` + middleware d'erreur Express +
   `process.on('unhandledRejection')`. Vérifié par reproduction empirique : un handler qui
   rejette renvoie désormais un 500 propre au lieu de tuer le processus.
2. **`attachTenantConnection`** (`server/src/auth.js`) — `app.is_plateforme_admin` est
   maintenant réinitialisé à l'**acquisition** de la connexion, pas seulement au relâchement.
   Corrige aussi les commentaires de `auth.js` et `rls-policies.sql` qui affirmaient à tort que
   l'échappatoire plateforme était en lecture seule.
3. **`POST /clients/:id/pin`** (`server/src/routes/clients.js`) — ajout du filtre `tenant_id`,
   correction du `logAudit` (tenantId manquant), ajout d'un `try/catch`.
4. **Sauvegarde chiffrée des secrets** (`deploy/backup.sh`, `deploy/DEPLOIEMENT.md`) —
   `server/.env` et `deploy/certbot/ovh.ini` sont chiffrés (GPG/AES-256) et inclus dans la
   synchronisation R2. `BACKUP_SECRETS_PASSPHRASE` généré et configuré sur le VPS.
5. **Garde-fou `DATABASE_URL`** (`server/src/index.js`) — le serveur refuse de démarrer en
   production sans `DATABASE_URL` (évite de servir silencieusement une base en mémoire avec des
   secrets par défaut). Le healthcheck `/api/health` interroge maintenant réellement la base
   (503 si injoignable) au lieu de renvoyer un texte statique.
6. **Mode hors ligne** (`web/js/offline-queue.js`, `web/js/api.js`, `web/js/app.js`) — une
   action en attente n'est plus supprimée sur 401/403/5xx (seulement sur un refus métier
   explicite). Ajout d'un magasin d'échecs définitifs après 5 tentatives (visible, jamais
   silencieux) et d'un toast invitant à se reconnecter en cas de session expirée.

### 🔥 Incident critique découvert et résolu (hors plan initial)

En testant le correctif #4 (chiffrement des secrets), découverte que **les sauvegardes
automatiques échouaient à chaque exécution depuis ~77h** (5 échecs consécutifs, 2026-08-09 →
2026-08-11), sans qu'aucune alerte n'ait été remarquée. Trois causes en cascade, toutes liées au
passage à RLS réel du 2026-08-09 :

1. `pg_dump` tentait de verrouiller **tous** les schémas de la base Supabase (y compris
   `auth`/`storage`/`realtime`, internes à Supabase) → `--schema=public` ajouté.
2. RLS lui-même bloquait ensuite la lecture des tables (Postgres refuse un `COPY` partiel
   silencieux pour un rôle non propriétaire soumis à RLS) → nouveau rôle dédié **`erp_backup`**
   créé (lecture seule, `BYPASSRLS`, jamais utilisé par l'application — voir
   `server/src/provision-backup-role.sql`).
3. Droit de lecture manquant sur les séquences (distinct de celui sur les tables) → `GRANT`
   complémentaire ajouté.

**Aucune donnée perdue** : l'échec survenait avant la synchronisation R2, donc les sauvegardes
antérieures au 8 août 18h sont restées intactes. Cycle complet retesté avec succès le 2026-08-11
23h41 (dump 168 Ko, secrets chiffrés, synchronisé R2). Timer automatique (6h) sain.

**Ce que ça confirme** : le point 12 du plan ci-dessous ("tester une restauration") reste entier
et devient plus urgent — on a prouvé que la *création* fonctionne à nouveau, mais la
*restauration* elle-même n'a **toujours jamais été testée**.

### ✅ Item #7 — Job CI RLS (2026-08-11)

Nouveau job `verify-rls` dans `.github/workflows/ci.yml` : service Postgres 17 éphémère, applique
`schema.sql` + `enable-rls.sql` + `provision-role.sql` + `rls-policies.sql`, puis lance les 24
assertions de `verify-rls.js`. Bloque désormais le déploiement (`deploy.yml` appelle `ci.yml` en
entier) si une policy RLS régresse. Réussi du premier coup en production CI.

### ✅ Item #8 — CORS + verrouillage par compte (2026-08-11)

CORS restreint à `massla.sn` et ses sous-domaines (`server/src/cors-origine.js`, testé
isolément) au lieu de `Access-Control-Allow-Origin: *`. Verrouillage par compte sur le portail
client après 5 échecs / 15 min (`clients.pin_tentatives_echouees`, `pin_bloque_jusqu`,
migration-10), en plus de la limite par IP déjà en place. Vérifié en production : origine
`massla.sn` reçoit l'en-tête CORS, une origine arbitraire n'en reçoit aucun.

### ✅ Item #9 — Révocation de session staff via `token_version` (2026-08-11)

Colonne `utilisateurs.token_version` (migration-11), embarquée dans chaque JWT à l'émission.
`requireAuth` (`server/src/auth.js`) rejoint désormais systématiquement la table `utilisateurs`
à chaque requête et compare le `token_version` du token à celui en base (y compris pendant une
impersonation) — un changement de mot de passe, de rôle, de secteur ou une désactivation/
suppression de compte (`routes/utilisateurs.js`) invalide donc immédiatement toute session déjà
ouverte, au lieu d'attendre l'expiration naturelle du JWT (jusqu'à 12h). Testé (207/207,
+4 tests dédiés dont un scénario bout-en-bout token-valide-puis-révoqué). Déployé en production
(migration-11 exécutée par l'utilisateur, déploiement `a7d2bb9` réussi, santé prod vérifiée) —
effet de bord attendu et accepté : toutes les sessions staff déjà ouvertes ont été déconnectées
au moment du déploiement.

### ✅ Item #12 — Test de restauration de sauvegarde, chronométré (2026-08-12)

Restauration réelle testée dans un conteneur Postgres 17 jetable sur le VPS (port local
uniquement, supprimé après coup — zéro risque pour la production). Deux dumps testés : le dernier
cycle automatique (00h00 UTC, révélé antérieur aux migrations 10/11 exécutées un peu plus tard —
comportement attendu, pas un bug) et un dump frais généré à la demande. Résultat détaillé et
procédure reproductible documentés dans `deploy/DEPLOIEMENT.md` (§ « Test de restauration »).

Chaîne complète validée : `pg_dump` direct = 4,3s ; téléchargement du dernier dump depuis
Cloudflare R2 (stockage externalisé) = 0,7s pour 168 Ko ; `pg_restore` = 1,3s ; 28/28 tables
restaurées avec les colonnes des migrations récentes présentes, comptages métier cohérents,
intégrité référentielle vérifiée par jointure. Déchiffrement GPG du `.env` sauvegardé également
vérifié : les 17 variables attendues sont présentes, y compris `CREDENTIALS_ENCRYPTION_KEY` et
`JWT_SECRET` — la sauvegarde chiffrée des secrets (item lié à l'audit systèmes) est donc
réellement exploitable, pas seulement présente. RTO base de données à ce volume : quelques
secondes ; le facteur limitant en cas de sinistre total serait le reprovisionnement du VPS/de
l'application, pas la restauration des données elles-mêmes.

### ✅ Item #10 — Timeouts pool DB + appels externes (2026-08-12)

Ni le pool `pg` ni `fetch` n'avaient de limite de temps par défaut : une base injoignable ou un
PayDunya/WhatsApp/OpenRouteService muet gelait la requête entrante indéfiniment, jusqu'au timeout
du reverse proxy en amont (jamais celui de l'application elle-même). Pool (`server/src/db.js`) :
`connectionTimeoutMillis` 5s, `idleTimeoutMillis` 30s, `statement_timeout` 15s. Appels externes
(`AbortSignal.timeout`, Node 20) : PayDunya 15s (`paydunya.js`), WhatsApp 10s (`whatsapp.js`),
OpenRouteService 8s (`routing.js` — repli déjà en place vers le calcul à vol d'oiseau / ligne
droite, le timeout ne fait qu'accélérer ce repli au lieu de le retarder). Testé (207/207, aucune
régression), pas de surface UI observable — rien à vérifier au navigateur.

### ✅ Item #11 — Supervision externe (2026-08-12)

`backup.sh` sait pinguer un `HEALTHCHECKS_PING_URL` optionnel (succès en fin de cycle, `/fail` via
le trap existant) — un « dead man's switch » qui comble l'angle mort resté invisible 77h lors de
l'incident du 2026-08-09 : le cas où le script ne s'exécute pas du tout (VPS injoignable, timer
désactivé), que ni `monitor.sh` ni le trap `ntfy` de `backup.sh` ne peuvent détecter puisqu'ils
tournent tous les deux *sur* le VPS lui-même.

Comptes UptimeRobot (moniteur HTTP sur `/api/health`) et Healthchecks.io créés par l'utilisateur.
`HEALTHCHECKS_PING_URL` ajouté à `server/.env` sur le VPS et vérifié bout en bout : un cycle de
sauvegarde déclenché manuellement a bien envoyé le ping (`200 OK`, confirmé aussi côté tableau de
bord Healthchecks.io — passé au vert).

### ✅ Item #13 — Dépôt GPS et en-tête de facture PDF par ferme (2026-08-12)

Le dépôt de départ des tournées (`routing.js`) et l'en-tête de la facture PDF (`facturePdf.js` :
nom, adresse, téléphone) étaient codés en dur sur Ferme Massla (Diamniadio) pour TOUTES les fermes
clientes. Ajout de `organisations.gps_lat/gps_lng/adresse/telephone` (migration-12, nullables —
une ferme qui ne renseigne rien garde le comportement précédent), d'une route self-service
`GET/PUT /api/parametres-ferme` (admin uniquement) et d'un panneau « Informations de la ferme »
dans la vue Réglages (renommée depuis « Paiements (réglages) », qui héberge désormais 3 panneaux).
`routes/logistique.js` utilise le dépôt de la ferme quand il est configuré, sinon le repli par
défaut de `routing.js`.

Testé (215/215, +8 tests dédiés) **et vérifié en navigateur** (pg-mem, serveur de dev local) :
réglages enregistrés et relus correctement, dépôt de tournée reflète bien des coordonnées
distinctes du défaut une fois configurées, en-tête PDF contient l'adresse/téléphone saisis
(confirmé par décodage du flux PDF compressé, pas juste une recherche de texte en clair qui aurait
donné un faux négatif). Migration-12 exécutée par l'utilisateur, déploiement `a02dfc4` réussi,
santé prod vérifiée.

### ✅ Vérification croisée montant/référence sur l'IPN PayDunya (2026-08-12)

Trouvé lors de l'audit sécurité (E5, `01-securite.md`) : `paydunya.js` documentait déjà
`referenceInterne` comme « vérification croisée en plus du token », mais `finance.js` ne la lisait
jamais, et `confirmation.montant` était appliqué tel quel sans jamais être confronté au montant
réellement attendu. Corrigé : `paiements.reference_interne` (migration-13), comparaison du montant
ET de la référence à la réception de l'IPN, tout écart marque le paiement `ECHOUE` (journalisé,
jamais crédité) au lieu d'être appliqué aveuglément. `rateLimit` 100/min ajouté sur l'endpoint
(oracle d'existence de token + amplification vers le quota API PayDunya). Testé (218/218, +3
tests dédiés).

### ✅ Contraintes UNIQUE par tenant + générateur de numero_commande (2026-08-12)

Trouvé lors de l'audit sécurité (M3, `01-securite.md`). `code_lot` (lots_production) et
`numero_commande` (commandes + commandes_fournisseurs) étaient `UNIQUE` globalement au lieu de
`UNIQUE (tenant_id, ...)` — une ferme pouvait bloquer définitivement une autre en utilisant le même
code. Pire : le générateur (`CMD-${Date.now().toString().slice(-6)}`) répétait les mêmes 6 chiffres
toutes les ~16,7 minutes, un bug de collision réel avec plusieurs fermes actives (500 en pleine
prise de commande). Corrigé : `UNIQUE (tenant_id, colonne)` (migration-14) + nouveau générateur
`numero.js` (horodatage + aléa + vérification d'unicité par ferme, élimine la collision plutôt que
de la rendre improbable). `utilisateurs.email`/`clients.telephone` restent volontairement globaux
(résolution du tenant à la connexion en dépend — décision déjà actée, voir task #50). Testé
(223/223, +3 tests dédiés).

### ✅ npm ci + registre de migrations SQL + registre d'images Docker (2026-08-12)

**`npm ci`** : `Dockerfile` utilisait `npm install --omit=dev` (peut mettre à jour
`package-lock.json` silencieusement si désynchronisé). Remplacé par `npm ci --omit=dev` — build
reproductible, échoue plutôt que de dériver. Testé : build Docker isolé sur le VPS (image jetable)
+ démarrage vérifié.

**Registre de migrations** : rien ne permettait de savoir rapidement quelles migrations SQL étaient
appliquées en prod (seule la mémoire de conversation en faisait foi). Nouvelle table
`schema_migrations` (`schema.sql` pour les bases fraîches, `migration-15` + backfill des
migrations 01-14 pour la prod) — chaque future migration s'enregistre elle-même en dernière ligne.

**Registre d'images Docker** : `docker compose up -d --build` écrasait le tag `latest` et l'ancienne
image partait au prune suivant — un rollback nécessitait de reconstruire depuis un ancien commit
(lent, résultat non garanti identique). `deploy.yml` tague désormais l'image en place par SHA de
commit avant reconstruction, garde les 5 dernières + `latest`. Rollback devenu : retaguer + redémarrer
sans reconstruire (instantané). Logique de rétention testée isolément sur le VPS (images jetables).
Procédure complète documentée dans `DEPLOIEMENT.md`.

## Plan d'action restant

Toute la liste « cette semaine » et « ce mois-ci » de l'audit du 2026-08-11 est terminée (items
#1 à #13). De la liste « Ensuite », non urgente, reste :

### Ensuite

- Échapper les 2 endroits XSS restants (noms de secteur)
- Régénérer le secret ntfy (paramétrable depuis aujourd'hui, mais toujours la valeur historique)
- Réduire la durée des sessions d'impersonation superviseur (12h → 30-60 min)

## Verdict global des trois experts

- **Sécurité** : posture nettement au-dessus de la moyenne (RLS réel, chiffrement AES-256-GCM,
  0 vulnérabilité npm en prod), mais des failles structurelles à fort impact plutôt que des
  oublis de débutant.
- **Systèmes** : maturité opérationnelle rare pour un projet solo (CI/CD, sauvegardes
  externalisées, TLS auto-renouvelé), tient pour 1 à 5 fermes, à muscler avant 15-20.
- **Développement** : code 7/10, process de vérification 4/10 — le vrai risque n'est pas la
  qualité du code écrit, c'est que la garantie la plus critique (l'isolation entre fermes)
  dépendait d'un script lancé à la main.

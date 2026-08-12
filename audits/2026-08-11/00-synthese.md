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

## Plan d'action restant

### Ce mois-ci

| # | Action | Effort | Statut |
|---|---|---|---|
| 9 | `token_version` pour révoquer une session staff avant les 12h | ~2h | À faire |
| 10 | Régler le pool DB (timeouts) + délai max sur les appels PayDunya/WhatsApp/ORS | ~0,5j | À faire |
| 11 | Supervision externe (UptimeRobot + Healthchecks.io, gratuits) | ~2h | À faire — aurait détecté l'incident sauvegardes en 5 min au lieu de 77h |
| 12 | Tester une restauration de sauvegarde, chronométrée | ~0,5j | À faire — **priorité relevée**, voir ci-dessus |
| 13 | Dépôt GPS et en-tête de facture PDF par ferme (au lieu de codés en dur sur Massla) | ~3h | À faire |

### Ensuite

- Vérification croisée réelle du montant/référence sur l'IPN PayDunya
- Contraintes `UNIQUE` par tenant + correction du générateur de numéro de commande
- Registre de migrations SQL + registre d'images Docker pour rollback rapide
- `npm ci` au lieu de `npm install` dans le Dockerfile de production
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

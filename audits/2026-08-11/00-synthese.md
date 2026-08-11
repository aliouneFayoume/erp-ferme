# Synthèse — Comité d'audit ERP Ferme (2026-08-11)

Trois experts (sécurité, systèmes/infrastructure, développement), chacun avec plus de 20 ans
d'expérience, ont audité indépendamment le code et l'infrastructure d'ERP Ferme, sans se
concerter. Rapports complets :

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
  staff, création de ferme, réglages PayDunya) ont exactement cette signature.
- **Sécurité ET Développement** ont trouvé, indépendamment, **les deux mêmes lignes de code non
  échappées** (XSS) dans le frontend.

## Correctifs déjà appliqués (2026-08-11, cette session)

Les 6 actions "cette semaine" ont été implémentées, testées (188/188 tests passent) et sont
prêtes à déployer :

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
   `server/.env` et `deploy/certbot/ovh.ini` sont désormais chiffrés (GPG/AES-256) et inclus
   dans la synchronisation R2, si `BACKUP_SECRETS_PASSPHRASE` est défini. **Étape manuelle
   restante côté VPS** : générer la passphrase et la stocker dans un coffre personnel (voir
   `DEPLOIEMENT.md`, section "Secrets — sauvegarde chiffrée hors du VPS").
5. **Garde-fou `DATABASE_URL`** (`server/src/index.js`) — le serveur refuse de démarrer en
   production sans `DATABASE_URL` (évite de servir silencieusement une base en mémoire avec des
   secrets par défaut). Le healthcheck `/api/health` interroge maintenant réellement la base
   (503 si injoignable) au lieu de renvoyer un texte statique.
6. **Mode hors ligne** (`web/js/offline-queue.js`, `web/js/api.js`, `web/js/app.js`) — une
   action en attente n'est plus supprimée sur 401/403/5xx (seulement sur un refus métier
   explicite). Ajout d'un magasin d'échecs définitifs après 5 tentatives (visible, jamais
   silencieux) et d'un toast invitant à se reconnecter en cas de session expirée.

## Plan d'action restant

### Ce mois-ci

| # | Action | Effort |
|---|---|---|
| 7 | Job CI avec vrai Postgres qui applique RLS et lance `verify-rls.js` | ~0,5j |
| 8 | Restreindre le CORS à `massla.sn` + verrouillage par compte sur le portail | ~2h |
| 9 | `token_version` pour révoquer une session staff avant les 12h | ~2h |
| 10 | Régler le pool DB (timeouts) + délai max sur les appels PayDunya/WhatsApp/ORS | ~0,5j |
| 11 | Supervision externe (UptimeRobot + Healthchecks.io, gratuits) | ~2h |
| 12 | Tester une restauration de sauvegarde, chronométrée | ~0,5j |
| 13 | Dépôt GPS et en-tête de facture PDF par ferme (au lieu de codés en dur sur Massla) | ~3h |

### Ensuite

- Vérification croisée réelle du montant/référence sur l'IPN PayDunya
- Contraintes `UNIQUE` par tenant + correction du générateur de numéro de commande
- Registre de migrations SQL + registre d'images Docker pour rollback rapide
- `npm ci` au lieu de `npm install` dans le Dockerfile de production
- Échapper les 2 endroits XSS restants (noms de secteur)
- Retirer le secret ntfy committé en clair (partiellement fait — voir `backup.sh`)

## Verdict global des trois experts

- **Sécurité** : posture nettement au-dessus de la moyenne (RLS réel, chiffrement AES-256-GCM,
  0 vulnérabilité npm en prod), mais des failles structurelles à fort impact plutôt que des
  oublis de débutant.
- **Systèmes** : maturité opérationnelle rare pour un projet solo (CI/CD, sauvegardes
  externalisées, TLS auto-renouvelé), tient pour 1 à 5 fermes, à muscler avant 15-20.
- **Développement** : code 7/10, process de vérification 4/10 — le vrai risque n'est pas la
  qualité du code écrit, c'est que la garantie la plus critique (l'isolation entre fermes)
  dépendait d'un script lancé à la main.

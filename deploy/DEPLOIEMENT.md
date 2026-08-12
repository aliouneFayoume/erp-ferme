# Déploiement sur VPS — ERP Ferme Massla

## État actuel (déployé et vérifié)

- VPS : Oracle Cloud Infrastructure, Ubuntu 24.04, IP `40.233.98.20`, utilisateur SSH `ubuntu`.
- Domaine : `massla.sn` (+ `www.massla.sn`), DNS pointé vers l'IP ci-dessus.
- HTTPS actif via Let's Encrypt (`https://massla.sn`), HTTP redirige automatiquement en 301.
- Renouvellement du certificat automatisé (`erp-ferme-renew.timer`, 2x/jour).
- Sauvegardes Postgres automatisées (`erp-ferme-backup.timer`, toutes les 6h, rétention 14 jours).
- Surveillance de disponibilité (`erp-ferme-monitor.timer`, toutes les 2h, alerte push via ntfy.sh).
- Base : Supabase Postgres 17 via connexion pooler (`server/.env`, non commité).
- CI/CD : GitHub Actions (`aliouneFayoume/erp-ferme`) — tests à chaque push, déploiement
  automatique sur le VPS (`git pull` + rebuild Docker) sur push vers `main`.

⚠️ **Le déploiement peut échouer silencieusement.** `ci.yml` est déclenché deux fois par push sur
`main` (directement, et via l'appel réutilisable depuis `deploy.yml`) ; avant correction, ces deux
exécutions partageaient le même groupe de concurrence et s'annulaient parfois l'une l'autre —
`deploy` passait alors en `skipped` sans qu'aucune étape n'échoue, et le health check du VPS
continuait de répondre (avec l'ancien code) comme si tout allait bien. Corrigé le 2026-08-06 en
scopant le groupe de concurrence par `github.event_name`. Après un push, vérifier la conclusion
réelle du run sur `github.com/aliouneFayoume/erp-ferme/actions` plutôt que de se fier uniquement à
`/api/health`.

Ce qui suit reste utile comme référence/point de départ pour un nouveau déploiement ou une
migration de VPS.

⚠️ **Avant de déployer le module Fournisseurs (approvisionnement)** : exécuter une fois
`server/src/migration-01-fournisseurs.sql` contre la base de production (SQL Editor du projet
Supabase, ou `psql "$DATABASE_URL" -f server/src/migration-01-fournisseurs.sql`) — cette base est
déjà peuplée, donc `npm run migrate` (qui rejoue tout `schema.sql`) ne doit pas être relancé dessus.
Voir la section "Évolutions de schéma après la mise en production" du README racine.

## Passage multi-tenant (Massla = tenant #1) — runbook, PAS ENCORE EXÉCUTÉ

La branche `feature/multi-tenant-saas` fait passer l'application d'un modèle mono-tenant à un
modèle où chaque ferme cliente (organisation) est isolée par `tenant_id`, avec son propre
agrégateur de paiement PayDunya. C'est un changement de fond, pas une fonctionnalité de plus —
séquence à respecter strictement, chaque étape confirmée séparément avant de passer à la suivante.

**Phase A — Schéma (additif, zéro risque, exécutable à tout moment)**

L'ancien code ignore complètement les nouvelles tables/colonnes : cette phase ne change AUCUN
comportement observable de l'application actuellement en ligne.

```bash
# Sauvegarde de précaution immédiate (au lieu d'attendre le prochain cycle de 6h) :
ssh -i ~/.ssh/erp_ferme_vps ubuntu@40.233.98.20 \
  "set -a; source /home/ubuntu/erp-ferme/server/.env; set +a; /home/ubuntu/erp-ferme/deploy/backup.sh"

# Puis, contre la base de production (SQL Editor Supabase, ou) :
psql "$DATABASE_URL" -f server/src/migration-03-multi-tenant.sql
```

Vérifier ensuite (chaque décompte doit valoir 0) :
```sql
SELECT 'utilisateurs', COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM utilisateurs
UNION ALL SELECT 'clients', COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM clients
UNION ALL SELECT 'commandes', COUNT(*) FILTER (WHERE tenant_id IS NULL) FROM commandes;
-- (et ainsi de suite pour chaque table listée en tête de migration-03-multi-tenant.sql)
```

**Phase B — Migrer les identifiants PayDunya actuels vers la table chiffrée**

Toujours avant de déployer le nouveau code — les clés actuelles vivent dans `server/.env`
(`PAYDUNYA_MASTER_KEY`, `PAYDUNYA_PRIVATE_KEY`, `PAYDUNYA_PUBLIC_KEY`, `PAYDUNYA_TOKEN`,
`PAYDUNYA_MODE`), à recopier dans `organisation_paydunya_config` pour le tenant Massla via
`paymentConfig.js` (chiffrement fait en JS, pas en SQL) :

```js
// one-off, à exécuter localement avec le DATABASE_URL de prod chargé, jamais committé
require('dotenv').config();
const { Pool } = require('pg');
const { setPaydunyaConfig } = require('./server/src/paymentConfig');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  const { rows } = await pool.query(`SELECT id FROM organisations WHERE nom = 'Ferme Massla'`);
  await setPaydunyaConfig(pool, rows[0].id, {
    mode: process.env.PAYDUNYA_MODE || 'test',
    masterKey: process.env.PAYDUNYA_MASTER_KEY,
    privateKey: process.env.PAYDUNYA_PRIVATE_KEY,
    publicKey: process.env.PAYDUNYA_PUBLIC_KEY,
    token: process.env.PAYDUNYA_TOKEN,
  }, rows[0].id); // mis_a_jour_par : pas d'utilisateur précis pour une migration, id de l'org en repli
  await pool.end();
})();
```

**Phase C — Ajouter `CREDENTIALS_ENCRYPTION_KEY` au `.env` du VPS**

Nouvelle variable obligatoire dès que `DATABASE_URL` est défini (même garde-fou que `JWT_SECRET`,
le serveur refuse de démarrer sans) :
```bash
openssl rand -hex 32   # à coller comme valeur de CREDENTIALS_ENCRYPTION_KEY dans server/.env sur le VPS
```

**Phase D — Déployer le nouveau code**

Fusionner `feature/multi-tenant-saas` dans `main` (côté monorepo, sur une branche dédiée d'abord
pour revue) puis déployer via le pipeline habituel (subtree split + push + vérification via l'API
GitHub Actions, jamais se fier au seul health check — voir plus haut).

**À anticiper juste après le déploiement :**
- Les tokens JWT du staff déjà connecté avant le déploiement n'ont pas de `tenant_id` (ancien
  format) : leurs écrans afficheront des listes vides jusqu'à reconnexion. Se résorbe seul en 12h
  maximum (durée de vie d'un token staff), ou prévenir l'équipe de se reconnecter juste après.
- Le portail client n'est PAS affecté : `requireClientAuth` relit le client (et son `tenant_id`)
  en base à chaque requête plutôt que de le porter dans le token, donc aucune session client
  existante ne casse.
- Vérifier immédiatement après déploiement : connexion admin, tableau de bord, et que l'écran
  "Paiements (réglages)" affiche bien "Configuré" pour Massla sans ressaisie.

**Rollback** : le schéma étant 100% additif, un rollback du CODE seul (`git reset --hard
<commit-precedent> && docker compose up -d --build` sur le VPS) suffit à annuler la Phase D sans
toucher aux Phases A/B/C — l'ancien code continue de fonctionner normalement avec les colonnes
`tenant_id` en place mais ignorées.

## Prérequis

- Un VPS avec accès SSH root ou sudo, Docker + docker compose plugin installés.
- Un nom de domaine dont le DNS pointe vers l'IP du VPS (A record). Nécessaire pour le TLS.
- La base Supabase déjà configurée (`server/.env` avec `DATABASE_URL` + `JWT_SECRET`, voir
  README.md racine) — copier ce fichier sur le VPS, **ne jamais le committer dans git**. Le
  fichier doit être encodé en UTF-8 **sans BOM** (un BOM en tête fait échouer le parsing
  `EnvironmentFile=` de systemd utilisé par les timers de sauvegarde/renouvellement).

## Option A — Docker (recommandé, utilisée en production)

```bash
# Sur le VPS, après avoir installé Docker + docker compose plugin :
git clone <votre-repo> erp-ferme   # ou scp/rsync du dossier depuis ce poste
cd erp-ferme
cp /chemin/vers/votre/.env server/.env   # ne pas versionner ce fichier
docker compose up -d --build
```

L'app tourne alors derrière nginx sur le port 80. Passer au TLS ci-dessous.

## Option B — Sans Docker (Node direct + systemd)

```bash
# Sur le VPS :
sudo mkdir -p /opt/erp-ferme
sudo useradd -r -s /usr/sbin/nologin erpferme   # utilisateur dédié, pas root
# copier server/ et web/ dans /opt/erp-ferme/ (structure relative identique au dépôt)
cd /opt/erp-ferme/server && npm install --omit=dev
sudo chown -R erpferme:erpferme /opt/erp-ferme

sudo cp deploy/erp-ferme.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erp-ferme
sudo systemctl status erp-ferme
```

Installer nginx séparément (`apt install nginx`) et utiliser `deploy/nginx.conf` comme point de
départ pour `/etc/nginx/sites-available/erp-ferme` (adapter `proxy_pass` vers
`http://127.0.0.1:4000` au lieu de `http://app:4000`, ce dernier n'existant qu'en réseau Docker).

## Registre de migrations SQL + registre d'images Docker (rollback rapide)

**Constat (audit systèmes/développement 2026-08-11) :** avant ceci, rien ne permettait de répondre
rapidement à « quelles migrations SQL ont été appliquées en prod ? » (seule la mémoire de
conversation en faisait foi) ni à « comment revenir à la version précédente si ce déploiement casse
quelque chose ? » (`docker compose up -d --build` écrasait le tag `latest` et l'ancienne image
partait au prune suivant, sans trace).

### Registre de migrations SQL

Table `schema_migrations` (créée par `schema.sql` pour toute base fraîche, et par
`migration-15-registre-migrations.sql` sur la base de production, avec un backfill des migrations
01-14 déjà appliquées avant que cette table existe). Chaque migration future doit se terminer par
son propre enregistrement :

```sql
INSERT INTO schema_migrations (nom) VALUES ('migration-NN-nom-du-fichier.sql')
ON CONFLICT (nom) DO NOTHING;
```

Vérifier l'état réel de la base à tout moment (Supabase SQL Editor) :

```sql
SELECT nom, appliquee_le FROM schema_migrations ORDER BY appliquee_le;
```

### Registre d'images Docker

`docker-compose.yml` nomme explicitement l'image (`erp-ferme-app:latest`, plutôt que de dépendre du
nom du dossier de déploiement). Le workflow `deploy.yml` tague désormais l'image en place avec le
SHA du commit qu'elle sert **avant** de la reconstruire, et conserve les 5 dernières images taguées
(en plus de `latest`) après chaque déploiement réussi — un rollback ne nécessite donc plus de
reconstruire depuis un ancien commit (lent, et rien ne garantit que la reconstruction reproduise
exactement les mêmes octets).

**Rollback rapide** (sur le VPS, en cas de problème détecté après un déploiement) :

```bash
docker images erp-ferme-app   # lister les SHA disponibles (5 derniers + latest)
docker tag erp-ferme-app:<sha-precedent> erp-ferme-app:latest
docker compose up -d --no-build app   # instantané : pas de reconstruction, juste un redémarrage
```

Penser à revenir aussi le code source au même commit (`git reset --hard <sha-precedent>`) si le
rollback doit être durable — sinon le prochain déploiement (`git push`) réintroduira la version
problématique.

## TLS (HTTPS) avec Let's Encrypt

Une fois le DNS du domaine pointé vers le VPS et nginx qui répond sur le port 80, décommenter les
volumes `certbot/conf` et `certbot/www` dans `docker-compose.yml` (déjà fait pour ce déploiement),
puis :

```bash
docker compose up -d nginx   # recrée le conteneur avec les volumes montés

docker run --rm -v ./deploy/certbot/conf:/etc/letsencrypt -v ./deploy/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot -d votre-domaine.tld -d www.votre-domaine.tld \
  --non-interactive --agree-tos -m votre@email.tld
```

Puis dans `deploy/nginx.conf` : le bloc `server_name` du port 80 devient une redirection 301 vers
HTTPS, et le bloc `listen 443 ssl` (avec les chemins `ssl_certificate`/`ssl_certificate_key`) est
actif — voir le fichier actuel pour l'état final. Ouvrir le port 443 dans `docker-compose.yml`
(`ports: - "443:443"`) et dans le pare-feu du VPS (`iptables`/`netfilter-persistent` si pas
d'`ufw`), puis `docker compose up -d nginx`.

### Renouvellement automatique

`deploy/certbot-renew.sh` relance `certbot renew` (webroot) puis recharge nginx ; certbot ne
renouvelle réellement que si l'échéance est proche (~30 jours), donc l'exécuter souvent ne fait
rien tant que ce n'est pas nécessaire.

```bash
sudo cp deploy/erp-ferme-renew.service deploy/erp-ferme-renew.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erp-ferme-renew.timer
systemctl list-timers erp-ferme-renew.timer   # vérifier la prochaine exécution
```

### Wildcard `*.massla.sn` (sous-domaines par ferme) — DNS-01 via OVH

Un certificat wildcard ne peut PAS être validé par HTTP-01/webroot (méthode ci-dessus) — il faut
prouver la possession du domaine via un enregistrement DNS temporaire (DNS-01), ce qui nécessite un
accès à l'API du registrar. `massla.sn` est chez OVH (nameservers `dns106.ovh.net`), d'où l'usage du
plugin `certbot-dns-ovh` (image Docker `certbot/dns-ovh`, pas `certbot/certbot`).

Prérequis, une fois :
1. Enregistrement DNS `A` `*.massla.sn` → IP du VPS (zone DNS OVH).
2. Jeton API OVH ([api.ovh.com/createToken](https://api.ovh.com/createToken/), région Europe pour
   ce compte) avec les droits `GET /domain/zone/*` (nécessaire pour que le plugin détecte la zone —
   `GET /domain/zone/massla.sn/*` seul renvoie 403) et `POST`/`PUT`/`DELETE` sur
   `/domain/zone/massla.sn/*`, validité "Unlimited".
3. `deploy/certbot/ovh.ini` (jamais versionné — `deploy/certbot/` est dans `.gitignore`, permissions
   `600`) :
   ```ini
   dns_ovh_endpoint = ovh-eu
   dns_ovh_application_key = ...
   dns_ovh_application_secret = ...
   dns_ovh_consumer_key = ...
   ```

Obtention initiale (étend la lineage `massla.sn` existante en place, mêmes chemins que le certificat
webroot précédent — `*.massla.sn` couvre déjà `www.massla.sn`, ne pas le lister en plus, Let's
Encrypt refuse la redondance) :
```bash
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/ovh.ini:/etc/ovh.ini:ro" \
  certbot/dns-ovh \
  certonly --dns-ovh --dns-ovh-credentials /etc/ovh.ini --dns-ovh-propagation-seconds 30 \
  --cert-name massla.sn -d massla.sn -d '*.massla.sn' \
  --agree-tos --non-interactive --expand
```
Le renouvellement automatique (`deploy/certbot-renew.sh`) utilise déjà `certbot/dns-ovh renew`
(l'authenticator `dns-ovh` et le chemin des identifiants sont mémorisés dans
`deploy/certbot/conf/renewal/massla.sn.conf` après l'obtention initiale) — rien à reconfigurer côté
timer systemd, juste s'assurer que `ovh.ini` reste présent sur le VPS.

## Sauvegardes toutes les 6h

```bash
# Ubuntu 24.04 : le paquet postgresql-client par défaut (v16) ne peut PAS dumper un serveur
# Postgres 17 (cas de Supabase) — ajouter le dépôt officiel PGDG pour avoir la bonne version :
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update && sudo apt-get install -y postgresql-client-17

sudo cp deploy/erp-ferme-backup.service deploy/erp-ferme-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erp-ferme-backup.timer
systemctl list-timers erp-ferme-backup.timer   # vérifier la prochaine exécution
```

### Rôle dédié aux sauvegardes (`erp_backup`) — requis depuis le passage à RLS réel

**Constat production 2026-08-11 : sans ce rôle, `pg_dump` échoue à chaque exécution une fois RLS
actif**, avec `"query would be affected by row-level security policy"` — Postgres refuse par défaut
qu'un rôle non propriétaire et soumis à RLS fasse un `COPY` complet d'une table à policies, plutôt
que de produire silencieusement un dump partiel. `DATABASE_URL` (rôle `erp_app`, durci pour RLS —
voir `provision-role.sql`) ne convient donc pas pour les sauvegardes, et ne doit **jamais** recevoir
`BYPASSRLS` (ce serait désactiver RLS pour l'application elle-même).

Étape unique, à faire une fois via l'éditeur SQL Supabase :

```bash
# 1. Générer un mot de passe :
openssl rand -base64 32

# 2. Coller server/src/provision-backup-role.sql dans l'éditeur SQL Supabase, après avoir
#    remplacé <MOT_DE_PASSE_A_GENERER> par la valeur ci-dessus.

# 3. Sur le VPS, ajouter BACKUP_DATABASE_URL à server/.env — même hôte/port/base que
#    DATABASE_URL, utilisateur "erp_backup.<project_ref>" et le mot de passe généré :
echo 'BACKUP_DATABASE_URL=postgresql://erp_backup.<project_ref>:<mot_de_passe>@<host_pooler>:5432/postgres' \
  >> /home/ubuntu/erp-ferme/server/.env
```

Sans `BACKUP_DATABASE_URL`, `backup.sh` retente avec `DATABASE_URL` (fonctionne uniquement si RLS
n'est pas actif sur la base — jamais le cas en production depuis le 2026-08-09).

### Externalisation (Cloudflare R2)

`deploy/backup.sh` fait un `pg_dump` local puis `rclone sync` vers un bucket Cloudflare R2 —
sortant gratuit, adapté au volume d'une petite structure. Le remote `r2` est défini dans
`~/.config/rclone/rclone.conf` sur le VPS, **jamais versionné dans le dépôt** (fichier créé/édité
à la main sur le VPS, pas via un déploiement Git) :

```bash
# Sur le VPS, une fois pour toutes :
curl https://rclone.org/install.sh | sudo bash

mkdir -p ~/.config/rclone
cat > ~/.config/rclone/rclone.conf <<'EOF'
[r2]
type = s3
provider = Cloudflare
access_key_id = <access_key_id du token R2, scopé au bucket>
secret_access_key = <secret_access_key du token R2>
endpoint = https://<account_id>.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
chmod 600 ~/.config/rclone/rclone.conf
```

Créer le bucket (`erp-ferme-backups`) et le token d'API (permissions **Object Read & Write**,
restreint à ce bucket) depuis le dashboard Cloudflare → R2 → Manage API Tokens. Vérifier ensuite
avec `rclone ls r2:erp-ferme-backups`. `rclone sync` (et non `copy`) mirrore la rétention 14 jours
déjà appliquée localement par `backup.sh` : un fichier supprimé localement disparaît du bucket au
cycle suivant, sans configuration de lifecycle côté R2 à maintenir séparément.

Une synchronisation qui échoue déclenche la même alerte ntfy qu'un `pg_dump` en échec (`trap ERR`
dans `backup.sh`) — pas de mode dégradé silencieux.

### Secrets (server/.env, ovh.ini) — sauvegarde chiffrée hors du VPS

**Constat (audit systèmes 2026-08-11) : sans ce qui suit, `CREDENTIALS_ENCRYPTION_KEY` — la clé qui
chiffre les identifiants PayDunya/WhatsApp de CHAQUE ferme cliente — n'existe qu'en un seul
exemplaire sur ce VPS, jamais sauvegardée.** Perdre le VPS rendrait ces identifiants de paiement
définitivement indéchiffrables pour toutes les fermes, même avec la base restaurée par ailleurs.
Même remarque, moins grave, pour `JWT_SECRET` et pour `deploy/certbot/ovh.ini` (identifiants OVH du
renouvellement TLS).

`deploy/backup.sh` chiffre désormais `server/.env` et `deploy/certbot/ovh.ini` (GPG symétrique,
AES-256) et les inclut dans la synchronisation R2, **si et seulement si** `BACKUP_SECRETS_PASSPHRASE`
est défini. Étape manuelle, à faire une fois, sur le VPS :

```bash
# 1. Générer une passphrase forte (à noter ailleurs, voir étape 2 — jamais dans le dépôt) :
openssl rand -base64 32

# 2. L'ajouter à server/.env sur le VPS :
echo 'BACKUP_SECRETS_PASSPHRASE=<la valeur générée ci-dessus>' >> /home/ubuntu/erp-ferme/server/.env

# 3. Vérifier qu'un cycle de sauvegarde chiffre bien les secrets :
set -a; source /home/ubuntu/erp-ferme/server/.env; set +a
/home/ubuntu/erp-ferme/deploy/backup.sh
ls /home/ubuntu/erp-ferme/backups/secrets/
```

**La passphrase elle-même ne doit JAMAIS finir sur le VPS seul ni dans R2** — sinon on a juste
déplacé le point de défaillance unique. Elle doit vivre dans un endroit que la perte du VPS
n'affecte pas : un gestionnaire de mots de passe personnel (Bitwarden, 1Password...), ou à défaut
une note conservée hors ligne. C'est cette passphrase, gardée séparément, qui rend la sauvegarde
chiffrée réellement utile en cas de reconstruction complète.

Pour déchiffrer un fichier lors d'une restauration :

```bash
gpg --batch --yes --passphrase "<passphrase>" --decrypt secrets/.env-<horodatage>.gpg > .env
```

### Test de restauration (à refaire périodiquement)

Une sauvegarde qui n'a jamais été restaurée n'est qu'une hypothèse — l'incident du 2026-08-09
(§ ci-dessus, `backup.sh`) a montré qu'un `pg_dump` peut échouer silencieusement pendant des jours.
Procédure de test, sans aucun risque pour la production (tout se passe dans un conteneur Postgres
jetable sur le VPS, jamais exposé au réseau, supprimé à la fin) :

```bash
# 1. Récupérer le dernier dump depuis R2 (ou utiliser un fichier local dans backups/)
DERNIER=$(rclone lsf r2:erp-ferme-backups --files-only | grep '\.dump$' | sort | tail -1)
rclone copy "r2:erp-ferme-backups/$DERNIER" /tmp/

# 2. Conteneur Postgres jetable, port local uniquement
docker run -d --name erp-restore-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=restore_test \
  -p 127.0.0.1:55432:5432 postgres:17
docker cp "/tmp/$DERNIER" erp-restore-test:/tmp/restore.dump

# 3. Restauration chronométrée
docker exec -e PGPASSWORD=test erp-restore-test \
  pg_restore -U postgres -d restore_test --no-owner --no-privileges -j 2 /tmp/restore.dump

# 4. Vérifications minimales : tables présentes, colonnes des migrations récentes, comptages
docker exec -e PGPASSWORD=test erp-restore-test psql -U postgres -d restore_test -c "\dt"
docker exec -e PGPASSWORD=test erp-restore-test psql -U postgres -d restore_test -c "
  SELECT (SELECT count(*) FROM organisations) AS fermes, (SELECT count(*) FROM utilisateurs) AS users;"

# 5. Nettoyage
docker rm -f erp-restore-test
rm -f "/tmp/$DERNIER"
```

**Résultat du test du 2026-08-12** : dump frais (`pg_dump` direct, hors cycle) = 4,3s ; téléchargement
du dernier dump depuis R2 = 0,7s pour 168 Ko ; `pg_restore` (2 jobs parallèles) = 1,3s ; 28/28 tables
restaurées, colonnes des migrations 10 et 11 présentes, comptages métier cohérents, jointure
`utilisateurs → organisations` intègre. Déchiffrement du `.env` sauvegardé (GPG) vérifié : les 17
variables attendues sont présentes, y compris `CREDENTIALS_ENCRYPTION_KEY` et `JWT_SECRET`. RTO
base de données pur, à ce volume de données, de l'ordre de quelques secondes — le facteur limitant
en cas de perte totale du VPS serait le temps de reprovisionner un serveur et l'application elle-même,
pas la restauration des données. À refaire après toute croissance significative du volume de données
ou changement de fournisseur de stockage (R2).

## Surveillance de disponibilité (toutes les 2h)

`deploy/monitor.sh` vérifie `https://massla.sn/api/health` et envoie une notification push via
[ntfy.sh](https://ntfy.sh) (gratuit, sans compte, sur un topic non listé) uniquement si l'appli ne
répond pas — silence total quand tout va bien. Limite connue : le contrôle tourne sur le VPS
lui-même, donc si le VPS entier est injoignable (réseau/panne matérielle), le contrôle ne s'exécute
pas et aucune alerte n'est envoyée — seule une panne applicative (conteneur planté, etc.) est
couverte.

**`NTFY_TOPIC` requis dans `server/.env`** (audit sécurité 2026-08-11 : l'ancien topic était codé
en dur, committé en clair dans l'historique du dépôt — quiconque l'ayant vu pouvait s'y abonner ou
y publier de fausses alertes ; régénéré et retiré du code le 2026-08-12). Sans cette variable,
`monitor.sh` et `backup.sh` échouent explicitement au lieu de se rabattre sur l'ancienne valeur
compromise :

```bash
# Une fois : générer un nouveau topic imprévisible et l'ajouter à server/.env sur le VPS.
echo "NTFY_TOPIC=erp-massla-alertes-$(openssl rand -hex 16)" >> /home/ubuntu/erp-ferme/server/.env
```

```bash
sudo cp deploy/erp-ferme-monitor.service deploy/erp-ferme-monitor.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erp-ferme-monitor.timer
systemctl list-timers erp-ferme-monitor.timer   # vérifier la prochaine exécution
```

`erp-ferme-monitor.service` charge `server/.env` via `EnvironmentFile` (même mécanisme que
`erp-ferme-backup.service`) — après toute modification de `server/.env`, `sudo systemctl
daemon-reload` n'est nécessaire que si le fichier `.service` lui-même a changé, pas pour une
simple mise à jour de `NTFY_TOPIC`.

Pour recevoir les alertes : installer l'app **ntfy** (iOS/Android) ou ouvrir
`https://ntfy.sh/<topic>` dans un navigateur, et s'abonner au topic défini dans `server/.env`
(`NTFY_TOPIC`).

## Supervision externe (audit systèmes 2026-08-11, item #11)

**Constat** : `monitor.sh` ci-dessus tourne *sur* le VPS — si le VPS entier tombe (coupure réseau,
panne matérielle, disque plein), le contrôle ne s'exécute plus et aucune alerte ne part. Même
limite pour le trap `ERR` de `backup.sh` : il n'alerte que si le script se lance et échoue, pas
s'il ne se lance pas du tout (timer systemd désactivé par erreur, cron cassé) — exactement le
scénario resté invisible 77h lors de l'incident du 2026-08-09. Deux services externes gratuits
comblent ce point aveugle en surveillant depuis *l'extérieur* du VPS. **Étape manuelle, à faire une
fois** (nécessite de créer un compte sur chacun — à faire personnellement, pas par un agent) :

### 1. UptimeRobot — l'application répond-elle depuis l'extérieur ?

1. Créer un compte gratuit sur [uptimerobot.com](https://uptimerobot.com).
2. Nouveau moniteur : type **HTTP(s)**, URL `https://massla.sn/api/health`, intervalle 5 min.
3. Alerte attendue : le corps de la réponse contient `"statut":"En ligne"` — UptimeRobot peut
   vérifier un mot-clé attendu (`En ligne`) en plus du code HTTP 200, pour détecter aussi le cas où
   `/api/health` répond 503 (base injoignable, voir `server/src/index.js`).
4. Ajouter un contact d'alerte (email et/ou l'app mobile UptimeRobot) dans les réglages du compte.

### 2. Healthchecks.io — le cycle de sauvegarde tourne-t-il vraiment toutes les 6h ?

`deploy/backup.sh` sait déjà envoyer un ping à `HEALTHCHECKS_PING_URL` (succès en fin de script,
`/fail` si le trap `ERR` se déclenche) — **si cette variable n'est pas définie, comportement
strictement inchangé**, rien à faire pour l'activer plus tard.

1. Créer un compte gratuit sur [healthchecks.io](https://healthchecks.io).
2. Nouveau check : période **6 heures**, grâce (grace period) **1 heure** (laisse une marge avant
   l'alerte si un cycle est simplement un peu en retard).
3. Copier l'URL de ping fournie (forme `https://hc-ping.com/<uuid>`).
4. L'ajouter à `server/.env` sur le VPS :
   ```bash
   echo 'HEALTHCHECKS_PING_URL=https://hc-ping.com/<uuid>' >> /home/ubuntu/erp-ferme/server/.env
   ```
5. Vérifier qu'un cycle de sauvegarde envoie bien le ping (le tableau de bord Healthchecks.io passe
   au vert après un cycle) :
   ```bash
   set -a; source /home/ubuntu/erp-ferme/server/.env; set +a
   /home/ubuntu/erp-ferme/deploy/backup.sh
   ```

## Checklist sécurité avant mise en production réelle

- [x] Changer les mots de passe des comptes de démonstration (`demo1234`) via le module
      Utilisateurs, ou les supprimer et créer de vrais comptes.
- [x] `JWT_SECRET` doit être une valeur longue et unique par environnement (déjà appliqué : le
      serveur refuse de démarrer sans, dès que `DATABASE_URL` est défini).
- [x] Pare-feu VPS : n'ouvrir que 22 (SSH, idéalement par clé uniquement), 80 et 443.
- [x] Restreindre l'accès SSH (clé uniquement, `PasswordAuthentication no` — déjà actif par défaut
      sur cette image Ubuntu, vérifié dans `/etc/ssh/sshd_config.d/60-cloudimg-settings.conf`).
- [x] Vérifier que `server/.env` n'est jamais commité (déjà exclu par `.gitignore`).
- [x] Externaliser les sauvegardes hors du VPS (`rclone sync` vers Cloudflare R2, voir section
      "Sauvegardes toutes les 6h" ci-dessus).

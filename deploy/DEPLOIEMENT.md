# Déploiement sur VPS — ERP Ferme Massla

## État actuel (déployé et vérifié)

- VPS : Oracle Cloud Infrastructure, Ubuntu 24.04, IP `40.233.98.20`, utilisateur SSH `ubuntu`.
- Domaine : `massla.sn` (+ `www.massla.sn`), DNS pointé vers l'IP ci-dessus.
- HTTPS actif via Let's Encrypt (`https://massla.sn`), HTTP redirige automatiquement en 301.
- Renouvellement du certificat automatisé (`erp-ferme-renew.timer`, 2x/jour).
- Sauvegardes Postgres automatisées (`erp-ferme-backup.timer`, toutes les 6h, rétention 14 jours).
- Base : Supabase Postgres 17 via connexion pooler (`server/.env`, non commité).

Ce qui suit reste utile comme référence/point de départ pour un nouveau déploiement ou une
migration de VPS.

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

`deploy/backup.sh` ne fait qu'un `pg_dump` **local** sur le VPS (`/home/ubuntu/erp-ferme/backups`
pour ce déploiement) — lire les commentaires du script pour brancher une synchronisation vers un
stockage externe (S3, rclone, etc.) une fois le prestataire de stockage choisi. C'est le point
restant pour respecter pleinement l'exigence « backups externalisés » du cahier des charges.

## Checklist sécurité avant mise en production réelle

- [x] Changer les mots de passe des comptes de démonstration (`demo1234`) via le module
      Utilisateurs, ou les supprimer et créer de vrais comptes.
- [x] `JWT_SECRET` doit être une valeur longue et unique par environnement (déjà appliqué : le
      serveur refuse de démarrer sans, dès que `DATABASE_URL` est défini).
- [x] Pare-feu VPS : n'ouvrir que 22 (SSH, idéalement par clé uniquement), 80 et 443.
- [ ] Restreindre l'accès SSH (clé uniquement, `PasswordAuthentication no`).
- [x] Vérifier que `server/.env` n'est jamais commité (déjà exclu par `.gitignore`).
- [ ] Externaliser les sauvegardes hors du VPS (S3, rclone...).

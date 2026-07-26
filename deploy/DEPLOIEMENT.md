# Déploiement sur VPS — ERP Ferme Massla

Ce dossier contient tout ce qu'il faut pour déployer l'application une fois qu'un VPS est
disponible. Rien ici n'a été exécuté sur un serveur réel — c'est un point de départ prêt à
l'emploi. Recommandation cahier des charges : VPS localisé en **Europe** (latence optimisée vers
le Sénégal) et backups externalisés toutes les 6h.

## Prérequis

- Un VPS Europe (ex : Hetzner, OVH, Scaleway) avec accès SSH root ou sudo.
- Un nom de domaine dont le DNS pointe vers l'IP du VPS (A record). Nécessaire pour le TLS.
- La base Supabase déjà configurée (`server/.env` avec `DATABASE_URL` + `JWT_SECRET`, voir
  README.md racine) — copier ce fichier sur le VPS, **ne jamais le committer dans git**.

## Option A — Docker (recommandé)

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

Une fois le DNS du domaine pointé vers le VPS et nginx qui répond sur le port 80 :

```bash
# Docker : certbot en conteneur ponctuel partageant les volumes déclarés (commentés) dans docker-compose.yml
docker run --rm -v ./deploy/certbot/conf:/etc/letsencrypt -v ./deploy/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot -d votre-domaine.tld

# Sans Docker :
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d votre-domaine.tld
```

Puis décommenter le bloc HTTPS dans `deploy/nginx.conf` (et le port 443 dans
`docker-compose.yml` si Docker), recharger nginx. Penser au renouvellement automatique
(`certbot renew`, généralement déjà planifié par le paquet certbot ; en Docker, prévoir un cron
qui relance la commande `certonly` puis `docker compose exec nginx nginx -s reload`).

## Sauvegardes externalisées toutes les 6h

```bash
sudo apt install postgresql-client   # fournit pg_dump
sudo cp deploy/erp-ferme-backup.service deploy/erp-ferme-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now erp-ferme-backup.timer
systemctl list-timers erp-ferme-backup.timer   # vérifier la prochaine exécution
```

`deploy/backup.sh` ne fait qu'un `pg_dump` **local** sur le VPS — lire les commentaires du script
pour brancher une synchronisation vers un stockage externe (S3, rclone, etc.) une fois le
prestataire de stockage choisi.

## Checklist sécurité avant mise en production réelle

- [ ] Changer les mots de passe des comptes de démonstration (`demo1234`) via le module
      Utilisateurs, ou les supprimer et créer de vrais comptes.
- [ ] `JWT_SECRET` doit être une valeur longue et unique par environnement (déjà appliqué : le
      serveur refuse de démarrer sans, dès que `DATABASE_URL` est défini).
- [ ] Pare-feu VPS : n'ouvrir que 22 (SSH, idéalement par clé uniquement), 80 et 443.
- [ ] Restreindre l'accès SSH (clé uniquement, `PasswordAuthentication no`).
- [ ] Vérifier que `server/.env` n'est jamais commité (déjà exclu par `.gitignore`).

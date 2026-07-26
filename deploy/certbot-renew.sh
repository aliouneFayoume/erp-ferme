#!/usr/bin/env bash
# Renouvelle le certificat Let's Encrypt (webroot) puis recharge nginx. Le certificat initial a été
# obtenu manuellement pour massla.sn — ce script est destiné à tourner via le timer systemd
# erp-ferme-renew.timer (voir DEPLOIEMENT.md), certbot ne renouvelant que si l'échéance approche.
set -euo pipefail
cd /home/ubuntu/erp-ferme
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/www:/var/www/certbot" \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet
docker compose exec nginx nginx -s reload

#!/usr/bin/env bash
# Renouvelle le certificat Let's Encrypt (webroot) puis recharge nginx. Le certificat initial a été
# obtenu manuellement pour massla.sn — ce script est destiné à tourner via le timer systemd
# erp-ferme-renew.timer (voir DEPLOIEMENT.md), certbot ne renouvelant que si l'échéance approche.
set -euo pipefail

NTFY_TOPIC="erp-massla-alertes-97963866109cd7138fe636fb"
trap 'curl -s -H "Title: Renouvellement certificat ERP Massla en échec" -H "Priority: urgent" -H "Tags: warning" -d "Le renouvellement du $(date -u +%Y-%m-%dT%H:%M:%SZ) a échoué (ligne $LINENO) — vérifier avant expiration." "https://ntfy.sh/$NTFY_TOPIC" > /dev/null' ERR

cd /home/ubuntu/erp-ferme
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/www:/var/www/certbot" \
  certbot/certbot renew --webroot -w /var/www/certbot --quiet
docker compose exec nginx nginx -s reload

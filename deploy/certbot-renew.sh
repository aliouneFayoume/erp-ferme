#!/usr/bin/env bash
# Renouvelle le certificat Let's Encrypt puis recharge nginx — tourne via le timer systemd
# erp-ferme-renew.timer (voir DEPLOIEMENT.md), certbot ne renouvelant que si l'échéance approche.
#
# Depuis l'ajout du wildcard *.massla.sn (sous-domaines par ferme), le certificat "massla.sn" est
# validé par DNS-01 (API OVH) au lieu de webroot/HTTP-01 — un wildcard ne peut PAS être validé par
# HTTP-01. L'image `certbot/dns-ovh` (au lieu de `certbot/certbot`) embarque le plugin nécessaire ;
# `deploy/certbot/ovh.ini` (identifiants API OVH, jamais versionné, permissions 600) doit être monté
# exactement à /etc/ovh.ini, le chemin enregistré dans le renewal params du certificat
# (deploy/certbot/conf/renewal/massla.sn.conf) lors de l'obtention initiale.
set -euo pipefail

NTFY_TOPIC="erp-massla-alertes-97963866109cd7138fe636fb"
trap 'curl -s -H "Title: Renouvellement certificat ERP Massla en échec" -H "Priority: urgent" -H "Tags: warning" -d "Le renouvellement du $(date -u +%Y-%m-%dT%H:%M:%SZ) a échoué (ligne $LINENO) — vérifier avant expiration." "https://ntfy.sh/$NTFY_TOPIC" > /dev/null' ERR

cd /home/ubuntu/erp-ferme
docker run --rm \
  -v "$(pwd)/deploy/certbot/conf:/etc/letsencrypt" \
  -v "$(pwd)/deploy/certbot/ovh.ini:/etc/ovh.ini:ro" \
  certbot/dns-ovh renew --quiet
docker compose exec nginx nginx -s reload

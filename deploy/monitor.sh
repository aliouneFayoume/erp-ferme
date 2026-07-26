#!/usr/bin/env bash
# Vérifie que l'application répond (health check public) et envoie une notification push via
# ntfy.sh (service gratuit, sans compte, topic non listé) si elle est injoignable. Ne notifie PAS
# quand tout va bien, pour éviter le bruit — seulement en cas de panne détectée.
set -uo pipefail

URL="https://massla.sn/api/health"
NTFY_TOPIC="erp-massla-alertes-97963866109cd7138fe636fb"

if ! curl -fsS --max-time 10 "$URL" > /dev/null; then
    curl -s \
        -H "Title: ERP Ferme Massla — hors ligne" \
        -H "Priority: urgent" \
        -H "Tags: warning,rotating_light" \
        -d "$URL ne répond pas ($(date -u +%Y-%m-%dT%H:%M:%SZ))." \
        "https://ntfy.sh/$NTFY_TOPIC" > /dev/null
fi

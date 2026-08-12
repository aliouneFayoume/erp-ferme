#!/usr/bin/env bash
# Vérifie que l'application répond (health check public) et envoie une notification push via
# ntfy.sh (service gratuit, sans compte, topic non listé) si elle est injoignable. Ne notifie PAS
# quand tout va bien, pour éviter le bruit — seulement en cas de panne détectée.
set -uo pipefail

URL="https://massla.sn/api/health"
# Anciennement codé en dur ici, sans même lecture d'environnement (contrairement à backup.sh qui
# était déjà paramétrable) — un topic ntfy.sh est public par défaut, quiconque lisant l'historique
# du dépôt pouvait s'y abonner ou y publier de fausses alertes. Constat audit sécurité 2026-08-11 ;
# secret régénéré le 2026-08-12 — voir DEPLOIEMENT.md pour le définir dans server/.env (le service
# systemd (erp-ferme-monitor.service) le charge désormais via EnvironmentFile).
if [ -z "${NTFY_TOPIC:-}" ]; then
    echo "NTFY_TOPIC doit être défini dans server/.env (voir DEPLOIEMENT.md)." >&2
    exit 1
fi

if ! curl -fsS --max-time 10 "$URL" > /dev/null; then
    curl -s \
        -H "Title: ERP Ferme Massla — hors ligne" \
        -H "Priority: urgent" \
        -H "Tags: warning,rotating_light" \
        -d "$URL ne répond pas ($(date -u +%Y-%m-%dT%H:%M:%SZ))." \
        "https://ntfy.sh/$NTFY_TOPIC" > /dev/null
fi

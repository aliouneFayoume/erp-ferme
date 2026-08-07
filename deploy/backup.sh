#!/usr/bin/env bash
# Sauvegarde de la base (cahier des charges §4 : "backups externalisés toutes les 6 heures").
# Nécessite le paquet postgresql-client (pour pg_dump) sur le VPS.
# Usage : DATABASE_URL=... ./backup.sh   (ou renseigner DATABASE_URL dans server/.env
#         et lancer via le service systemd erp-ferme-backup, voir DEPLOIEMENT.md)

set -euo pipefail

NTFY_TOPIC="erp-massla-alertes-97963866109cd7138fe636fb"
# Alerte identique au monitoring (deploy/monitor.sh) : une sauvegarde qui échoue en silence est aussi
# dangereuse qu'une panne, on ne le découvre juste que le jour d'une restauration nécessaire.
trap 'curl -s -H "Title: Sauvegarde ERP Massla en échec" -H "Priority: urgent" -H "Tags: warning" -d "La sauvegarde du $(date -u +%Y-%m-%dT%H:%M:%SZ) a échoué (ligne $LINENO)." "https://ntfy.sh/$NTFY_TOPIC" > /dev/null' ERR

BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/erp-ferme/backups}"
RETENTION_JOURS="${RETENTION_JOURS:-14}"
HORODATAGE=$(date -u +%Y%m%dT%H%M%SZ)

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL doit être défini (charger server/.env avant d'appeler ce script)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
FICHIER="$BACKUP_DIR/erp-ferme-$HORODATAGE.dump"

pg_dump "$DATABASE_URL" --format=custom --file="$FICHIER"
echo "Sauvegarde créée : $FICHIER"

# Externalisation : synchronise vers Cloudflare R2 (remote "r2" défini dans
# ~/.config/rclone/rclone.conf sur le VPS, jamais versionné). `sync` (et non `copy`) pour que la
# purge locale ci-dessous se propage aussi côté distant au cycle suivant, sans devoir dupliquer la
# politique de rétention côté S3.
RCLONE_REMOTE="${RCLONE_REMOTE:-r2:erp-ferme-backups}"
rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE"
echo "Sauvegarde synchronisée vers $RCLONE_REMOTE"

find "$BACKUP_DIR" -name '*.dump' -mtime "+$RETENTION_JOURS" -delete

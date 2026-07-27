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

# ⚠️ Externalisation : ce script ne fait que la sauvegarde LOCALE sur le VPS. Pour respecter
# l'exigence de backups externalisés, synchroniser $BACKUP_DIR vers un stockage distant, par ex. :
#   rclone sync "$BACKUP_DIR" remote:erp-ferme-backups
#   aws s3 sync "$BACKUP_DIR" s3://votre-bucket/erp-ferme-backups
# (nécessite de configurer rclone/aws cli avec les identifiants du stockage choisi au préalable)

find "$BACKUP_DIR" -name '*.dump' -mtime "+$RETENTION_JOURS" -delete

#!/usr/bin/env bash
# Sauvegarde de la base (cahier des charges §4 : "backups externalisés toutes les 6 heures").
# Nécessite le paquet postgresql-client (pour pg_dump) sur le VPS.
# Usage : DATABASE_URL=... ./backup.sh   (ou renseigner DATABASE_URL dans server/.env
#         et lancer via le service systemd erp-ferme-backup, voir DEPLOIEMENT.md)

set -euo pipefail

# Anciennement en clair ici (committé dans le dépôt) — un topic ntfy.sh est public par défaut :
# quiconque lit le dépôt pouvait s'abonner aux alertes d'exploitation (savoir quand attaquer) et en
# publier de fausses. Renseigner NTFY_TOPIC dans server/.env (non versionné) ; la valeur ci-dessous
# n'est qu'un repli pour ne pas casser un VPS pas encore mis à jour — à régénérer et à retirer d'ici
# peu. Constat audit sécurité 2026-08-11.
NTFY_TOPIC="${NTFY_TOPIC:-erp-massla-alertes-97963866109cd7138fe636fb}"
# Alerte identique au monitoring (deploy/monitor.sh) : une sauvegarde qui échoue en silence est aussi
# dangereuse qu'une panne, on ne le découvre juste que le jour d'une restauration nécessaire.
#
# HEALTHCHECKS_PING_URL (audit systèmes 2026-08-11, item #11, optionnel — absent = comportement
# inchangé) : ce trap ntfy ne couvre que l'échec DÉTECTÉ d'un script qui s'exécute. Il ne couvre
# pas le cas où le script ne s'exécute pas du tout (VPS éteint, timer systemd désactivé par erreur,
# cron cassé) — un silence total, indiscernable d'une nuit calme, ce qui est exactement le scénario
# de l'incident du 2026-08-09 (77h sans sauvegarde utilisable avant détection). Healthchecks.io est
# un "dead man's switch" : c'est LUI qui alerte si aucun ping (succès ou échec) n'arrive dans le
# délai attendu, plutôt que de dépendre du script pour signaler son propre silence.
trap '[ -n "${HEALTHCHECKS_PING_URL:-}" ] && curl -fsS --max-time 10 "${HEALTHCHECKS_PING_URL}/fail" > /dev/null 2>&1; curl -s -H "Title: Sauvegarde ERP Massla en échec" -H "Priority: urgent" -H "Tags: warning" -d "La sauvegarde du $(date -u +%Y-%m-%dT%H:%M:%SZ) a échoué (ligne $LINENO)." "https://ntfy.sh/$NTFY_TOPIC" > /dev/null' ERR

BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/erp-ferme/backups}"
RETENTION_JOURS="${RETENTION_JOURS:-14}"
HORODATAGE=$(date -u +%Y%m%dT%H%M%SZ)

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL doit être défini (charger server/.env avant d'appeler ce script)." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
FICHIER="$BACKUP_DIR/erp-ferme-$HORODATAGE.dump"

# BACKUP_DATABASE_URL (rôle erp_backup, BYPASSRLS, lecture seule — voir provision-backup-role.sql)
# de préférence à DATABASE_URL (rôle applicatif erp_app, durci pour RLS — provision-role.sql).
# --schema=public dans les deux cas : ni l'un ni l'autre n'a de droits sur auth/storage/realtime,
# internes à Supabase, hors de notre périmètre de sauvegarde.
#
# BUGS RÉELS TROUVÉS EN PRODUCTION 2026-08-11, tous les deux depuis le passage à RLS réel
# (2026-08-09, commit ffd689b), tous les deux invisibles avant un test manuel : (1) pg_dump avec
# DATABASE_URL essayait par défaut TOUS les schémas de la base → "permission denied for schema
# auth" ; (2) même avec --schema=public, Postgres refuse par défaut qu'un rôle non propriétaire ET
# soumis à RLS fasse un COPY complet d'une table à policies ("query would be affected by row-level
# security policy"), plutôt que de produire silencieusement un dump partiel. Résultat cumulé :
# aucune sauvegarde utilisable pendant ~77h avant détection. erp_app ne doit JAMAIS avoir
# BYPASSRLS (ce serait désactiver RLS pour l'application elle-même) — d'où le second rôle, dédié
# uniquement à pg_dump, jamais référencé par le code applicatif.
DUMP_URL="${BACKUP_DATABASE_URL:-$DATABASE_URL}"
if [ -z "${BACKUP_DATABASE_URL:-}" ]; then
  echo "BACKUP_DATABASE_URL non défini : tentative avec DATABASE_URL (échouera si RLS est actif sur la base — voir provision-backup-role.sql)." >&2
fi
pg_dump "$DUMP_URL" --schema=public --format=custom --file="$FICHIER"
echo "Sauvegarde créée : $FICHIER"

# --- Secrets du serveur applicatif (audit systèmes 2026-08-11) --------------------------------
# CREDENTIALS_ENCRYPTION_KEY (chiffre les identifiants PayDunya/WhatsApp de CHAQUE ferme cliente),
# JWT_SECRET et les identifiants OVH (deploy/certbot/ovh.ini, renouvellement TLS) n'existaient
# qu'en un seul exemplaire sur ce VPS, jamais sauvegardés. Perdre ce VPS rendrait ces identifiants
# de paiement définitivement indéchiffrables pour toutes les fermes, même avec la base restaurée.
# Chiffrés avant envoi (BACKUP_SECRETS_PASSPHRASE, à définir dans server/.env, JAMAIS committée) :
# le contenu de server/.env et ovh.ini part chiffré même si le bucket R2 était un jour mal configuré.
SERVER_ENV="${SERVER_ENV_PATH:-/home/ubuntu/erp-ferme/server/.env}"
OVH_INI="${OVH_INI_PATH:-/home/ubuntu/erp-ferme/deploy/certbot/ovh.ini}"
if [ -n "${BACKUP_SECRETS_PASSPHRASE:-}" ]; then
  SECRETS_DIR="$BACKUP_DIR/secrets"
  mkdir -p "$SECRETS_DIR"
  for f in "$SERVER_ENV" "$OVH_INI"; do
    if [ -f "$f" ]; then
      NOM="$(basename "$f")"
      gpg --batch --yes --passphrase "$BACKUP_SECRETS_PASSPHRASE" --symmetric --cipher-algo AES256 \
        -o "$SECRETS_DIR/$NOM-$HORODATAGE.gpg" "$f"
    fi
  done
  # Purge locale des anciens secrets chiffrés (même rétention que les dumps) — seule la copie R2 fait foi.
  find "$SECRETS_DIR" -name '*.gpg' -mtime "+$RETENTION_JOURS" -delete
  echo "Secrets chiffrés dans $SECRETS_DIR (server/.env, ovh.ini)."
else
  echo "BACKUP_SECRETS_PASSPHRASE non défini : les secrets (clé de chiffrement, JWT_SECRET, ovh.ini) NE SONT PAS sauvegardés hors du VPS." >&2
fi

# Externalisation : synchronise vers Cloudflare R2 (remote "r2" défini dans
# ~/.config/rclone/rclone.conf sur le VPS, jamais versionné). `sync` (et non `copy`) pour que la
# purge locale ci-dessous se propage aussi côté distant au cycle suivant, sans devoir dupliquer la
# politique de rétention côté S3. Le dossier secrets/ (chiffré) est inclus dans la même synchro.
RCLONE_REMOTE="${RCLONE_REMOTE:-r2:erp-ferme-backups}"
rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE"
echo "Sauvegarde synchronisée vers $RCLONE_REMOTE"

find "$BACKUP_DIR" -name '*.dump' -mtime "+$RETENTION_JOURS" -delete

# Ping de succès (dead man's switch, voir plus haut) : signale à Healthchecks.io que ce cycle est
# allé jusqu'au bout. Sans cela (HEALTHCHECKS_PING_URL non défini), comportement inchangé.
if [ -n "${HEALTHCHECKS_PING_URL:-}" ]; then
  curl -fsS --max-time 10 "$HEALTHCHECKS_PING_URL" > /dev/null 2>&1 || true
fi

#!/usr/bin/env sh
# Restore a backup created by backup.sh:  ./scripts/restore.sh backups/datadog-search-....sql.gz
set -eu
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: $0 <backup.sql.gz>" >&2; exit 1; }
printf "This replaces all data in the datadog-search database. Continue? [y/N] "
read -r ans
[ "$ans" = "y" ] || exit 1
docker compose stop api worker web
gunzip -c "$1" | docker compose exec -T db psql -U search -d search -v ON_ERROR_STOP=1 >/dev/null
docker compose start api worker web
echo "Restore complete."

#!/usr/bin/env sh
# Dump the PostgreSQL database to ./backups/datadog-search-<timestamp>.sql.gz
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
out="backups/datadog-search-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T db pg_dump -U search -d search --clean --if-exists | gzip > "$out"
echo "Backup written to $out"

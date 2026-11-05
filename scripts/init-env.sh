#!/usr/bin/env sh
# Create .env from .env.example with freshly generated secrets.
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ]; then
  echo ".env already exists; not overwriting." >&2
  exit 1
fi
rand() { openssl rand -hex "$1"; }
sed -e "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(rand 12)/" \
    -e "s/^SESSION_SECRET=.*/SESSION_SECRET=$(rand 32)/" \
    -e "s/^DATA_ENCRYPTION_KEY=.*/DATA_ENCRYPTION_KEY=$(rand 32)/" \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(rand 16)/" \
    .env.example > .env
chmod 600 .env
echo "Created .env. Initial admin credentials are in .env (ADMIN_USERNAME / ADMIN_PASSWORD)."

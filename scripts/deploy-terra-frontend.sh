#!/usr/bin/env bash
set -euo pipefail

# Sync only the Terra webchat assets. This avoids touching unrelated site files.
# Usage:
#   ROOT=/root/terrarium-webchat \
#   STAGING=~/Programming/mbabbott-webpage/var/www/html/terra \
#   DEST=/var/www/html/terra \
#   sudo -E scripts/deploy-terra-frontend.sh

ROOT="${ROOT:-/root/terrarium-webchat}"
STAGING="${STAGING:-$HOME/Programming/mbabbott-webpage/var/www/html/terra}"
DEST="${DEST:-/var/www/html/terra}"

echo "Building frontend..."
cd "$ROOT"
npm run build --workspace packages/web-frontend

echo "Syncing to staging: $STAGING"
rsync -av --delete "$ROOT/packages/web-frontend/dist/" "$STAGING/"

echo "Publishing to $DEST"
rsync -av --delete "$STAGING/" "$DEST/"

echo "Setting ownership to www-data"
chown -R www-data:www-data "$DEST"

echo "Done. Visit your base path to verify (e.g., https://mbabbott.com/terra/)."

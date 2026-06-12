#!/bin/sh
# Deploy TurboMarbles to the bastille jail.
# Run as root (or a user with write access to the jail path).
#
# Usage: ./deploy.sh [--dry-run]

set -e

JAIL_ROOT="/usr/local/bastille/jails/marbles/root"
DEST="${JAIL_ROOT}/var/www/marbles"
SRC="$(cd "$(dirname "$0")" && pwd)"

RSYNC_OPTS="-av --delete"
if [ "${1}" = "--dry-run" ]; then
    RSYNC_OPTS="${RSYNC_OPTS} --dry-run"
    echo "[dry-run mode]"
fi

# Sync application files; exclude things that don't belong in production.
rsync ${RSYNC_OPTS} \
    --exclude='.git/' \
    --exclude='.env' \
    --exclude='node_modules/' \
    --exclude='test/' \
    --exclude='board-drawing' \
    --exclude='board-drawing-full' \
    --exclude='*.sqlite' \
    --exclude='*.sqlite3' \
    --exclude='deploy.sh' \
    --exclude='*.md' \
    "${SRC}/" "${DEST}/"

if [ "${1}" = "--dry-run" ]; then
    echo "Dry run complete — no files written, skipping npm install."
    exit 0
fi

# Install / update production dependencies inside the jail.
bastille cmd marbles sh -c "cd /var/www/marbles && npm install --omit=dev --prefer-offline"

echo "Deploy complete."

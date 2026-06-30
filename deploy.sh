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
sudo rsync ${RSYNC_OPTS} \
    --exclude='.git/' \
    --exclude='.env' \
    --exclude='node_modules/' \
    --exclude='test/' \
    --exclude='board-drawing' \
    --exclude='board-drawing-full' \
    --exclude='*.sqlite' \
    --exclude='*.sqlite3' \
    --exclude='deploy.sh' \
    --exclude='rc.d/' \
    --exclude='*.md' \
    "${SRC}/" "${DEST}/"

if [ "${1}" = "--dry-run" ]; then
    echo "Dry run complete — no files written, skipping npm install."
    exit 0
fi

# Install / update production dependencies inside the jail.
bastille cmd marbles sh -c "cd /var/www/marbles && npm install --omit=dev --prefer-offline"

# Fix ownership so the service user can read the app files.
bastille cmd marbles chown -R www:www /var/www/marbles

# Install the RC script and make it executable.
sudo install -m 755 "${SRC}/rc.d/turbomarbles" "${JAIL_ROOT}/usr/local/etc/rc.d/turbomarbles"

# Restart the service if it is enabled in the jail's rc.conf; otherwise
# remind the operator to enable it.
if bastille cmd marbles sysrc -n turbomarbles_enable 2>/dev/null | grep -qi "^YES$"; then
    bastille cmd marbles service turbomarbles restart
    echo "turbomarbles service restarted."
else
    echo ""
    echo "NOTE: TurboMarbles is not yet enabled as a service."
    echo "To enable it, run inside the jail:"
    echo "  sysrc turbomarbles_enable=YES"
    echo "  service turbomarbles start"
fi

echo "Deploy complete."

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
    --exclude='tools/' \
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

# Provision the dedicated service account, idempotently. Using our own
# account rather than "www" keeps the web server's account separate from
# this app's.
bastille cmd marbles sh -c '
    pw usershow marbles >/dev/null 2>&1 || \
        pw useradd marbles -c "TurboMarbles service" \
            -d /var/www/marbles -s /usr/sbin/nologin -w no
'

# App code is owned by root and only readable by the service user, so a
# compromised server process can't rewrite its own code or dependencies.
# The service writes only its log and pid directory (set up by the rc script).
bastille cmd marbles sh -c 'chown -R root:wheel /var/www/marbles && chmod -R u=rwX,go=rX /var/www/marbles'

ENABLED=no
if bastille cmd marbles sysrc -n turbomarbles_enable 2>/dev/null | grep -qi "^YES$"; then
    ENABLED=yes
fi

# Stop with the CURRENTLY installed rc script before replacing it, so a change
# in how the script tracks the process (pidfile, procname) can't strand the
# old process. Not running is fine.
if [ "${ENABLED}" = yes ]; then
    bastille cmd marbles service turbomarbles onestop || true
fi

# Install the RC script and log rotation config.
sudo mkdir -p "${JAIL_ROOT}/usr/local/etc/rc.d" "${JAIL_ROOT}/etc/newsyslog.conf.d"
sudo install -m 755 "${SRC}/rc.d/turbomarbles" "${JAIL_ROOT}/usr/local/etc/rc.d/turbomarbles"
sudo install -m 644 "${SRC}/rc.d/turbomarbles.newsyslog.conf" \
    "${JAIL_ROOT}/etc/newsyslog.conf.d/turbomarbles.conf"

# Start the service if it is enabled in the jail's rc.conf; otherwise
# remind the operator to enable it.
if [ "${ENABLED}" = yes ]; then
    bastille cmd marbles service turbomarbles start
    echo "turbomarbles service started."
else
    echo ""
    echo "NOTE: TurboMarbles is not yet enabled as a service."
    echo "To enable it, run inside the jail:"
    echo "  sysrc turbomarbles_enable=YES"
    echo "  service turbomarbles start"
fi

echo "Deploy complete."

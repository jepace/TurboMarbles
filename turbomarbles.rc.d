#!/bin/sh
#
# PROVIDE: turbomarbles
# REQUIRE: NETWORKING DAEMON
# KEYWORD: shutdown
#
# Add the following to /etc/rc.conf to enable TurboMarbles:
#
#   turbomarbles_enable="YES"
#
# Optional overrides (set in /etc/rc.conf):
#
#   turbomarbles_user="www"          # user to run as (must exist)
#   turbomarbles_dir="/usr/local/share/turbomarbles"   # app directory
#   turbomarbles_port="3000"         # TCP port to listen on
#   turbomarbles_host="127.0.0.1"    # bind address (127.0.0.1 if behind a proxy)
#   turbomarbles_origin="https://example.com"          # allowed WebSocket origin
#   turbomarbles_node="/usr/local/bin/node"            # path to Node.js binary
#   turbomarbles_logfile="/var/log/turbomarbles.log"
#   turbomarbles_pidfile="/var/run/turbomarbles.pid"

. /etc/rc.subr

name="turbomarbles"
rcvar="turbomarbles_enable"

# Defaults — all overrideable in rc.conf
: ${turbomarbles_enable:="NO"}
: ${turbomarbles_user:="www"}
: ${turbomarbles_dir:="/usr/local/share/turbomarbles"}
: ${turbomarbles_port:="3000"}
: ${turbomarbles_host:="127.0.0.1"}
: ${turbomarbles_origin:=""}
: ${turbomarbles_node:="/usr/local/bin/node"}
: ${turbomarbles_logfile:="/var/log/turbomarbles.log"}
: ${turbomarbles_pidfile:="/var/run/turbomarbles.pid"}

pidfile="${turbomarbles_pidfile}"

# daemon(8) wraps Node:
#   -c       chdir to app directory
#   -p       write the inner pid to the pidfile
#   -u       drop privileges to this user
#   -o       redirect stdout+stderr to log file
#   -r       restart the process if it exits unexpectedly
#   -R 5     wait 5 seconds before restarting
command="/usr/sbin/daemon"
command_args="-c -p ${turbomarbles_pidfile} -u ${turbomarbles_user} \
  -o ${turbomarbles_logfile} -r -R 5 \
  ${turbomarbles_node} ${turbomarbles_dir}/src/server.js"

# Expose env vars to the Node process.  These are picked up by server.js.
export PORT="${turbomarbles_port}"
export HOST="${turbomarbles_host}"
export NODE_ENV="production"
# Only export ORIGIN if the operator set it; leaving it blank disables the check.
if [ -n "${turbomarbles_origin}" ]; then
  export ORIGIN="${turbomarbles_origin}"
fi

start_precmd="turbomarbles_precmd"

turbomarbles_precmd()
{
  # Sanity checks before handing off to daemon(8).
  if [ ! -x "${turbomarbles_node}" ]; then
    err 1 "Node.js not found at ${turbomarbles_node} — install it with: pkg install node22"
  fi
  if [ ! -f "${turbomarbles_dir}/src/server.js" ]; then
    err 1 "Application not found at ${turbomarbles_dir}/src/server.js"
  fi
  if ! id -u "${turbomarbles_user}" >/dev/null 2>&1; then
    err 1 "User '${turbomarbles_user}' does not exist — create it first"
  fi
  # Create log file if absent, owned by the run-as user.
  if [ ! -f "${turbomarbles_logfile}" ]; then
    install -m 640 -o "${turbomarbles_user}" /dev/null "${turbomarbles_logfile}"
  fi
}

load_rc_config "${name}"
run_rc_command "$1"

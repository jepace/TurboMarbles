# TurboMarbles — FreeBSD Deployment Guide

This guide takes you from a fresh FreeBSD 15 VPS to a fully running, TLS-protected, internet-facing TurboMarbles server.

## Overview

```
Internet → pf firewall → nginx (TLS) → Node.js on 127.0.0.1:8080
```

nginx terminates TLS and proxies both HTTP and WebSocket traffic to Node. Node binds to loopback only and is never directly reachable from outside.

---

## 1. System prerequisites

Log in as root (or `sudo` throughout).

### Update packages

```sh
pkg update && pkg upgrade
```

### Install required packages

```sh
pkg install node22 nginx acme.sh
```

| Package | Purpose |
|---|---|
| `node22` | Node.js runtime |
| `nginx` | Reverse proxy + TLS termination |
| `acme.sh` | Lightweight Let's Encrypt client (no Python dependency) |

Verify Node is working:

```sh
node --version   # should print v22.x.x
```

---

## 2. Create a service account

The Node process runs as an unprivileged user. Using an existing system account (`www`) is fine for a single-purpose VPS. If you prefer isolation, create a dedicated account:

```sh
pw useradd turbomarbles \
  -d /usr/local/share/turbomarbles \
  -s /usr/sbin/nologin \
  -c "TurboMarbles game server"
```

Then update `/etc/rc.conf` (covered in step 5) to use `turbomarbles_user="turbomarbles"`.

---

## 3. Deploy the application

```sh
# Create the install directory owned by the service account
install -d -m 755 -o turbomarbles /usr/local/share/turbomarbles

# Copy the application files (run from your local machine or via git)
git clone https://your-repo-url /usr/local/share/turbomarbles
# — or —
scp -r /path/to/TurboMarbles/* root@yourhost:/usr/local/share/turbomarbles/

# Install production dependencies only (no devDependencies)
cd /usr/local/share/turbomarbles
npm ci --omit=dev

# Fix ownership
chown -R turbomarbles:turbomarbles /usr/local/share/turbomarbles
```

---

## 4. Install the rc.d script

```sh
install -m 555 /usr/local/share/turbomarbles/turbomarbles.rc.d \
               /usr/local/etc/rc.d/turbomarbles
```

---

## 5. Configure the service

Add to `/etc/rc.conf`:

```sh
# /etc/rc.conf additions

turbomarbles_enable="YES"
turbomarbles_user="turbomarbles"
turbomarbles_dir="/usr/local/share/turbomarbles"
turbomarbles_host="127.0.0.1"
turbomarbles_port="8080"
turbomarbles_origin="https://yourhost.example.com"   # ← your actual domain
```

`turbomarbles_origin` activates WebSocket origin checking — any connection whose `Origin` header doesn't match this value is rejected at handshake time.

---

## 6. Configure the firewall (pf)

A minimal pf configuration that allows SSH, HTTP, and HTTPS while blocking everything else.

Create `/etc/pf.conf`:

```pf
# /etc/pf.conf

ext_if="vtnet0"          # replace with your actual external interface (check: ifconfig)
ssh_port="22"

# Block all incoming by default; allow outgoing
set block-policy drop
block in all
pass out all keep state

# Anti-spoofing
antispoof quick for $ext_if

# SSH — rate-limit to 3 connections per 30 seconds per source IP
pass in on $ext_if proto tcp to ($ext_if) port $ssh_port \
  keep state (max-src-conn-rate 3/30, overload <bruteforce>, flush global)
block quick from <bruteforce>

# HTTP and HTTPS for nginx
pass in on $ext_if proto tcp to ($ext_if) port { 80, 443 } keep state

# Loopback — unrestricted
pass on lo0 all
```

Enable and load:

```sh
# Enable pf
echo 'pf_enable="YES"' >> /etc/rc.conf
echo 'pflog_enable="YES"' >> /etc/rc.conf

# Load rules and start
service pf start
pfctl -f /etc/pf.conf
pfctl -e

# Verify
pfctl -sr    # show rules
pfctl -si    # show status
```

> **Note:** Replace `vtnet0` with your actual interface name. Check with `ifconfig` — it is often `vtnet0` on VirtIO-based VPSes (Vultr, DigitalOcean, Hetzner) or `em0` on older/bare-metal hosts.

Port 8080 is **not** open in this ruleset — Node is only reachable via nginx on loopback.

---

## 7. Obtain a TLS certificate (Let's Encrypt)

acme.sh is installed at `/usr/local/sbin/acme.sh`. Run it as root; it stores certificates in `~/.acme.sh/`.

```sh
# Register your email (once)
acme.sh --register-account -m you@example.com

# Issue a certificate using the HTTP-01 challenge.
# nginx must not be running yet (or must not own port 80 yet).
# acme.sh will spin up a temporary listener on port 80.
acme.sh --issue --standalone -d yourhost.example.com

# Install the certificate to a permanent location
install -d -m 700 /usr/local/etc/ssl/turbomarbles

acme.sh --install-cert -d yourhost.example.com \
  --cert-file   /usr/local/etc/ssl/turbomarbles/cert.pem \
  --key-file    /usr/local/etc/ssl/turbomarbles/key.pem \
  --fullchain-file /usr/local/etc/ssl/turbomarbles/fullchain.pem \
  --reloadcmd "service nginx reload"
```

acme.sh installs a cron job (in root's crontab) to renew the certificate automatically and run `--reloadcmd` when it does.

---

## 8. Configure nginx

Create `/usr/local/etc/nginx/nginx.conf`:

```nginx
# /usr/local/etc/nginx/nginx.conf

worker_processes auto;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;

    sendfile      on;
    keepalive_timeout 65;

    # Don't advertise nginx version in error pages or Server header
    server_tokens off;

    # Redirect all plain HTTP to HTTPS
    server {
        listen 80;
        server_name yourhost.example.com;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name yourhost.example.com;

        ssl_certificate     /usr/local/etc/ssl/turbomarbles/fullchain.pem;
        ssl_certificate_key /usr/local/etc/ssl/turbomarbles/key.pem;

        # Modern TLS only
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
        ssl_prefer_server_ciphers off;

        # HSTS — tells browsers to always use HTTPS for this domain
        # Enable only after you're sure TLS is working correctly
        # add_header Strict-Transport-Security "max-age=63072000" always;

        # Proxy everything to Node
        location / {
            proxy_pass         http://127.0.0.1:8080;
            proxy_http_version 1.1;

            # Required for WebSocket upgrade
            proxy_set_header   Upgrade    $http_upgrade;
            proxy_set_header   Connection "upgrade";

            # Pass real client IP to Node logs
            proxy_set_header   Host       $host;
            proxy_set_header   X-Real-IP  $remote_addr;
            proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto $scheme;

            # Keep WebSocket connections alive during a game
            proxy_read_timeout 3600s;
            proxy_send_timeout 3600s;
        }
    }
}
```

Replace both occurrences of `yourhost.example.com` with your actual domain.

Test the configuration, then enable nginx:

```sh
nginx -t   # must print "test is successful"

echo 'nginx_enable="YES"' >> /etc/rc.conf
service nginx start
```

---

## 9. Start TurboMarbles

```sh
service turbomarbles start
service turbomarbles status
```

Check the log:

```sh
tail -f /var/log/turbomarbles.log
```

You should see:

```
TurboMarbles listening on http://127.0.0.1:8080
```

Then open `https://yourhost.example.com` in a browser.

---

## 10. Configure log rotation

Create `/etc/newsyslog.conf.d/turbomarbles.conf`:

```
# logfile                         owner:group  mode  count  size  when  flags  pid-file
/var/log/turbomarbles.log         turbomarbles:turbomarbles  640   7      1024  *     J      /var/run/turbomarbles.pid
```

| Field | Value | Meaning |
|---|---|---|
| count | 7 | keep 7 rotated files |
| size | 1024 | rotate when log exceeds 1 MB |
| flags | J | compress with bzip2 |

The PID file is used to send SIGUSR1 to Node after rotation, which closes and reopens the log file descriptor.

> **Note:** Node.js does not handle SIGUSR1 for log rotation by default (it starts the inspector instead). The `-o` flag in `daemon(8)` redirects stdout/stderr at the OS level, so `newsyslog` simply truncates the file and the running process keeps writing to the same fd. For proper log rotation without losing lines, add the `B` flag (binary, no signal) instead:

```
/var/log/turbomarbles.log  turbomarbles:turbomarbles  640  7  1024  *  JB
```

Test rotation manually:

```sh
newsyslog -v /var/log/turbomarbles.log
```

---

## 11. Verify security

After everything is running, spot-check from an external machine:

```sh
# TLS certificate and redirect
curl -I http://yourhost.example.com         # should redirect 301 → https
curl -I https://yourhost.example.com        # should return 200, check headers

# Node is not directly reachable
curl http://yourhost.example.com:8080       # should time out or refuse

# HTTP security headers (helmet)
curl -s -I https://yourhost.example.com | grep -i "x-frame\|x-content\|referrer"

# WebSocket from a browser console (on https://yourhost.example.com):
#   new WebSocket('wss://yourhost.example.com')  → opens
#   new WebSocket('wss://yourhost.example.com') from a different origin → rejected
```

Optionally run a TLS quality check at https://www.ssllabs.com/ssltest/.

---

## 12. Enable HSTS (after TLS is confirmed working)

Once you're confident TLS is stable, uncomment the HSTS header in nginx.conf:

```nginx
add_header Strict-Transport-Security "max-age=63072000" always;
```

Then reload nginx:

```sh
service nginx reload
```

HSTS tells browsers to refuse plain HTTP for your domain for two years. Do not enable it before TLS is fully working — it is difficult to undo.

---

## Maintenance reference

| Task | Command |
|---|---|
| Start / stop / restart | `service turbomarbles start\|stop\|restart` |
| View live logs | `tail -f /var/log/turbomarbles.log` |
| Reload nginx config | `service nginx reload` |
| Renew certificate manually | `acme.sh --renew -d yourhost.example.com` |
| Update the app | `cd /usr/local/share/turbomarbles && git pull && npm ci --omit=dev && service turbomarbles restart` |
| Check open connections | `sockstat -4 -l` |
| Check pf state table | `pfctl -ss` |
| List active rooms (debug) | check Node logs — each `createRoom` is logged |

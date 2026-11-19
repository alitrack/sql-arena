#!/usr/bin/env bash
# Starts the lab server for cross-machine access.
#
#   ./scripts/serve.sh              # localhost only, http
#   ./scripts/serve.sh --lan        # 0.0.0.0 + https (self-signed)
#
# LAN mode uses https because OPFS, Web Locks and SharedArrayBuffer are only
# exposed in a secure context: over http://<lan-ip> the browser hides
# navigator.storage entirely, so persistence and cross-tab locking silently die.
set -euo pipefail
cd "$(dirname "$0")/.."

LAN=0
for arg in "$@"; do
  case "$arg" in
    --lan) LAN=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PORT=${PORT:-8791}

# 8765 is taken by an unrelated local service on this machine; probe upward so a
# stale listener never silently serves someone else's page under our URL.
port_free() { ! nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }
while ! port_free "$PORT"; do
  echo "    port $PORT busy, trying $((PORT + 1))" >&2
  PORT=$((PORT + 1))
done

if [[ "$LAN" == "1" ]]; then
  if [[ ! -f certs/cert.pem || ! -f certs/key.pem ]]; then
    echo "==> generating self-signed cert for LAN IPs"
    mkdir -p certs
    IP=$(node -e "
      const os=require('os');
      for (const list of Object.values(os.networkInterfaces()))
        for (const a of list||[]) if (a.family==='IPv4' && !a.internal) { console.log(a.address); process.exit(0); }
      console.log('127.0.0.1');
    ")
    echo "    using IP $IP"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout certs/key.pem -out certs/cert.pem -days 365 \
      -subj "/CN=$IP" -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" 2>/dev/null
  fi
  IP=$(node -e "
    const os=require('os');
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list||[]) if (a.family==='IPv4' && !a.internal) { console.log(a.address); process.exit(0); }
    console.log('127.0.0.1');
  ")
  echo "==> https://$IP:$PORT  (cert is self-signed: the other machine must accept it once)"
  echo "    persistence page : https://$IP:$PORT/public/warehouse.html"
  echo "    engine compare   : https://$IP:$PORT/public/compare.html?repeat=10"
  HOST=0.0.0.0 TLS=1 PORT=$PORT exec node test/server.mjs
else
  echo "==> http://localhost:$PORT"
  HOST=127.0.0.1 PORT=$PORT exec node test/server.mjs
fi
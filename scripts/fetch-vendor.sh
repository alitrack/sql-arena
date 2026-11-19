#!/usr/bin/env bash
# Copies the wasm payloads the pages load at runtime into public/vendor/.
#
# These files (~49 MB) are deliberately not committed. Run this once after
# `npm install`, before starting the server.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d node_modules ]]; then
  echo "node_modules missing — run: npm install --cache /tmp/npmcache" >&2
  exit 1
fi

mkdir -p public/vendor

copy() {
  local src="$1" dst="public/vendor/$(basename "$1")"
  if [[ ! -f "$src" ]]; then
    echo "missing: $src" >&2
    exit 1
  fi
  cp -f "$src" "$dst"
  printf '  %-42s %s\n' "$(basename "$src")" "$(du -h "$dst" | cut -f1)"
}

D=node_modules/@duckdb/duckdb-wasm/dist
P=node_modules/@electric-sql/pglite/dist
S=node_modules/@sqlite.org/sqlite-wasm/dist

echo "==> duckdb-wasm"
copy "$D/duckdb-base.wasm"
copy "$D/duckdb-browser-base.worker.js"
copy "$D/duckdb-browser.mjs"

echo "==> pglite"
copy "$P/pglite.wasm"
copy "$P/pglite.data"
copy "$P/initdb.wasm"

echo "==> sqlite-wasm"
copy "$S/sqlite3.wasm"

echo "done: $(du -sh public/vendor | cut -f1) in public/vendor"

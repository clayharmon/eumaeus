#!/usr/bin/env bash
# Bring a Mac from a fresh clone to a running, tailnet-reachable dispatcher. Idempotent.
# Needs: Apple `container` installed (admin pkg), mise or node 24, pnpm, tailscale (optional).
# Usage: scripts/setup-mac.sh [--serve]      # --serve also publishes /mcp on the tailnet with tailscale serve
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PORT="${EUMAEUS_PORT:-7777}"

step() { printf '\n== %s\n' "$*"; }

step "checks"
command -v container >/dev/null || { echo "Apple container is not installed. Get the signed pkg from https://github.com/apple/container/releases"; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm not found (mise install?)"; exit 1; }
echo "container $(container --version | awk '{print $4}') / node $(node --version) / pnpm $(pnpm --version)"

step "container system"
# stdin from /dev/null: a fresh install asks about the kernel on first start, and over ssh that prompt would read the script.
container system start </dev/null >/dev/null 2>&1 || true
container system status >/dev/null 2>&1 || { echo "container system did not start"; exit 1; }
# Needs the API server running. On a re-run it exits 1 with POSIX error 17 "File exists": the kernel is already in place.
if ! out="$(container system kernel set --recommended </dev/null 2>&1)"; then
  case "$out" in
    *'"File exists"'*) echo "kernel already installed" ;;
    *) printf '%s\n' "$out" | tail -1; exit 1 ;;
  esac
fi
echo "running"

step "dependencies"
pnpm install --frozen-lockfile --silent

step "job image"
scripts/build-image.sh

step "template disk"
# Nix plus devenv, devbox, mise, and Flox, cloned for each repo's first job. About 70 s and 2.4 GB the first time.
node scripts/disk.ts template --if-stale

step "secrets"
for f in secrets.env github-app.json; do
  if [ -f "$HOME/.config/eumaeus/$f" ]; then echo "ok   ~/.config/eumaeus/$f"; else echo "MISSING ~/.config/eumaeus/$f  (see Setup in README.md)"; fi
done

step "service"
scripts/service.sh install
sleep 2
scripts/service.sh status

if [ "${1:-}" = "--serve" ] && command -v tailscale >/dev/null; then
  step "tailnet"
  tailscale serve --bg --https="$PORT" "http://127.0.0.1:$PORT" >/dev/null
  HOST="$(tailscale status --self --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  echo "https://$HOST:$PORT/mcp"
  echo "token: $(grep '^EUMAEUS_AUTH_TOKEN=' "$HOME/.config/eumaeus/dispatcher.env" | cut -d= -f2)"
  echo "register: claude mcp add -s user -t http eumaeus https://$HOST:$PORT/mcp -H \"Authorization: Bearer <token>\""
fi

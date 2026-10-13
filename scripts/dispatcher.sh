#!/usr/bin/env bash
# Runs the dispatcher with a launchd-safe environment. Used by the launch agent and by `pnpm start:service`.
# Reads ~/.config/eumaeus/dispatcher.env (EUMAEUS_* settings, incl. EUMAEUS_AUTH_TOKEN) if present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV_FILE="${EUMAEUS_ENV_FILE:-$HOME/.config/eumaeus/dispatcher.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; # shellcheck disable=SC1090
  . "$ENV_FILE"; set +a
fi

NODE="${EUMAEUS_NODE:-}"
if [ -z "$NODE" ] && command -v mise >/dev/null; then NODE="$(cd "$ROOT" && mise which node 2>/dev/null || true)"; fi
[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "dispatcher.sh: node not found (set EUMAEUS_NODE)" >&2; exit 1; }

# The per-user container API server must be up before any job can start. Idempotent.
if ! container system status >/dev/null 2>&1; then
  echo "[dispatcher.sh] starting container system" >&2
  container system start >/dev/null 2>&1 || echo "[dispatcher.sh] container system start failed; jobs will fail until it is up" >&2
fi

cd "$ROOT"
exec "$NODE" --disable-warning=ExperimentalWarning src/index.ts

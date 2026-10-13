#!/usr/bin/env bash
# Update an installed dispatcher: pull, install deps, let running jobs finish, rebuild the job image, restart.
# Usage: scripts/update.sh [--no-pull]
# From the pause until the restart, new and queued jobs wait. Running jobs finish first; none is killed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ENV_FILE="${EUMAEUS_ENV_FILE:-$HOME/.config/eumaeus/dispatcher.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; # shellcheck disable=SC1090
  . "$ENV_FILE"; set +a
fi
DATA="${EUMAEUS_DATA:-$HOME/.local/share/eumaeus}"
DATA="${DATA/#\~/$HOME}"
PAUSE="$DATA/paused"
HEALTH="http://127.0.0.1:${EUMAEUS_PORT:-7777}/healthz"

step() { printf '\n== %s\n' "$*"; }
running() { curl -fsS "$HEALTH" 2>/dev/null | grep -o '"running":[0-9]*' | cut -d: -f2 || true; }

if [ "${1:-}" != "--no-pull" ]; then
  step "pull"
  before="$(git rev-parse HEAD:scripts/update.sh)"
  git pull --ff-only
  # bash keeps running the copy it opened, so a pull that changes this script would run the old steps.
  if [ "$(git rev-parse HEAD:scripts/update.sh)" != "$before" ]; then
    echo "scripts/update.sh changed; running the new one"
    exec "$ROOT/scripts/update.sh" --no-pull
  fi
fi

step "dependencies"
pnpm install --frozen-lockfile --silent

step "drain"
mkdir -p "$DATA"
touch "$PAUSE"
# Any exit before the restart (failed build, Ctrl-C) lifts the pause; the dispatcher resumes within 5 s.
trap 'rm -f "$PAUSE"' EXIT
n="$(running)"
if [ -z "$n" ]; then
  echo "no answer from $HEALTH; not waiting"
else
  last=""
  while [ "${n:-0}" -gt 0 ]; do
    [ "$n" != "$last" ] && echo "$n job(s) running; queued jobs wait. Ctrl-C lifts the pause."
    last="$n"; sleep 10; n="$(running)"
  done
  echo "no jobs running"
fi

step "job image"
scripts/build-image.sh
node scripts/disk.ts template --if-missing

step "restart"
# Restart before lifting the pause: the old process must not start a queued job the restart would kill.
scripts/service.sh restart
rm -f "$PAUSE"
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH" 2>/dev/null; then echo; exit 0; fi
  sleep 1
done
echo "no answer from $HEALTH after 30 s; see scripts/service.sh logs" >&2
exit 1

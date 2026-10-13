#!/usr/bin/env bash
# Host side. Run one job in a fresh VM.
# Usage: scripts/run-job.sh <owner/repo> "<task>" [runner] [model]
# Env: JOB_ID, IMAGE (eumaeus-job:dev), CPUS (4), MEMORY (4G), GH_USER (clayharmon), OPEN_PR (1),
#      GH_TOKEN (default: gh auth token -u $GH_USER; M0 shortcut, replaced by a GitHub App in M2),
#      EUMAEUS_SECRETS (~/.config/eumaeus/secrets.env, passed as --env-file if present).
set -euo pipefail

REPO="${1:?owner/repo}"; TASK="${2:?task}"; RUNNER="${3:-claude}"; MODEL="${4:-}"
JOB_ID="${JOB_ID:-$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 2)}"
IMAGE="${IMAGE:-eumaeus-job:dev}"
SECRETS="${EUMAEUS_SECRETS:-$HOME/.config/eumaeus/secrets.env}"
GH_TOKEN="${GH_TOKEN:-$(gh auth token -u "${GH_USER:-clayharmon}")}"

args=(run --rm --name "eumaeus-$JOB_ID" --cpus "${CPUS:-4}" --memory "${MEMORY:-4G}"
  -e "JOB_ID=$JOB_ID" -e "REPO=$REPO" -e "TASK=$TASK" -e "RUNNER=$RUNNER" -e "MODEL=$MODEL"
  -e "GH_TOKEN=$GH_TOKEN" -e "OPEN_PR=${OPEN_PR:-1}")
[ -f "$SECRETS" ] && args+=(--env-file "$SECRETS")

echo "job $JOB_ID -> $REPO runner=$RUNNER" >&2
# container 1.5 honors --rm only on exit 0; remove the VM record ourselves on any exit.
trap 'container rm -f "eumaeus-$JOB_ID" >/dev/null 2>&1 || true' EXIT
container "${args[@]}" "$IMAGE"

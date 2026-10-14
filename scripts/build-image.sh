#!/usr/bin/env bash
# Build the job image, stamped with this checkout's commit (EUMAEUS_COMMIT in the image, logged by every job).
# Usage: scripts/build-image.sh [image]      # default: $EUMAEUS_IMAGE, else eumaeus-job:dev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-${EUMAEUS_IMAGE:-eumaeus-job:dev}}"
# -dirty: images/job differs from HEAD, so the commit alone doesn't describe what was built.
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet HEAD -- images/job || echo -dirty)"

container builder start >/dev/null 2>&1 || true
# No -q: it stalled indefinitely on container 1.5.0.
container build --build-arg "COMMIT=$COMMIT" -t "$IMAGE" -f "$ROOT/images/job/Dockerfile" "$ROOT/images/job" 2>&1 | tail -3
container builder stop >/dev/null 2>&1 || true
# A rebuild leaves the previous image's layers dangling; 2.5 GB each, 21.6 GB after one day on the mini.
container image prune 2>&1 | tail -1 || true
echo "built $IMAGE at $COMMIT"

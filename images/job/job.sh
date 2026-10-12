#!/usr/bin/env bash
# Runs inside the job VM. Clone, run the agent, commit, push one branch.
# Required env: JOB_ID, REPO (owner/name), TASK, GH_TOKEN.
# Optional env: BASE_BRANCH (main), BRANCH (job/$JOB_ID), RUNNER (claude|shell), MODEL.
# Runner "claude" also needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
# stdout: one JSON line with the outcome. stderr: progress.
set -euo pipefail

: "${JOB_ID:?}" "${REPO:?}" "${TASK:?}" "${GH_TOKEN:?}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BRANCH="${BRANCH:-job/$JOB_ID}"
RUNNER="${RUNNER:-claude}"
MODEL="${MODEL:-}"

log() { printf '[job %s] %s\n' "$JOB_ID" "$*" >&2; }
emit() { printf '{"job_id":"%s","status":"%s"%s}\n' "$JOB_ID" "$1" "${2:-}"; }

git config --global user.name  "${GIT_AUTHOR_NAME:-eumaeus}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-eumaeus@users.noreply.github.com}"
git config --global init.defaultBranch main
gh auth setup-git >/dev/null

log "clone $REPO @ $BASE_BRANCH"
git clone -q --depth 1 --branch "$BASE_BRANCH" "https://github.com/$REPO.git" /work/repo
cd /work/repo
git checkout -q -b "$BRANCH"

log "runner=$RUNNER model=${MODEL:-default}"
case "$RUNNER" in
  claude)
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
      log "runner=claude needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN"
      emit failed ',"error":"no_anthropic_credentials"'; exit 3
    fi
    args=(-p --output-format json --dangerously-skip-permissions)
    [ -n "$MODEL" ] && args+=(--model "$MODEL")
    claude "${args[@]}" "$TASK" > /work/runner.json
    log "agent: $(jq -r '.result' /work/runner.json | head -c 2000)"
    log "cost_usd=$(jq -r '.total_cost_usd // "?"' /work/runner.json) turns=$(jq -r '.num_turns // "?"' /work/runner.json)"
    ;;
  shell)
    bash -c "$TASK"
    ;;
  *)
    log "unknown runner: $RUNNER"; emit failed ',"error":"unknown_runner"'; exit 2
    ;;
esac

if [ -z "$(git status --porcelain)" ]; then
  log "no changes"; emit no_changes; exit 0
fi

git add -A
git commit -q -m "eumaeus job $JOB_ID" -m "$TASK"
git push -q -u origin "$BRANCH"
log "pushed $BRANCH"
emit pushed ",\"branch\":\"$BRANCH\",\"commit\":\"$(git rev-parse HEAD)\",\"files\":$(git diff --name-only HEAD~1 | jq -R . | jq -sc .)"

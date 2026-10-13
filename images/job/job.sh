#!/usr/bin/env bash
# Runs inside the job VM. Clone, run the agent, commit, push one branch.
# Required env: JOB_ID, REPO (owner/name), TASK, GH_TOKEN.
# Optional env: BASE_BRANCH (main), BRANCH (job/$JOB_ID), RUNNER (claude|shell), MODEL,
#   GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL (commit identity), OPEN_PR (1 = open a pull request after push).
# Runner "claude" also needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
# stdout: one JSON line with the outcome. stderr: progress.
set -euo pipefail

: "${JOB_ID:?}" "${REPO:?}" "${TASK:?}" "${GH_TOKEN:?}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BRANCH="${BRANCH:-job/$JOB_ID}"
RUNNER="${RUNNER:-claude}"
MODEL="${MODEL:-}"
OPEN_PR="${OPEN_PR:-1}"
AGENT_SUMMARY=""
COST_LINE=""

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
    AGENT_SUMMARY="$(jq -r '.result // ""' /work/runner.json | head -c 4000)"
    COST_LINE="cost_usd=$(jq -r '.total_cost_usd // "?"' /work/runner.json) turns=$(jq -r '.num_turns // "?"' /work/runner.json)"
    log "agent: $(printf '%s' "$AGENT_SUMMARY" | head -c 2000)"
    log "$COST_LINE"
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

PR_URL=""
if [ "$OPEN_PR" = "1" ]; then
  title="$(printf '%s' "$TASK" | head -n1 | cut -c1-72)"
  # shellcheck disable=SC2016  # backticks are literal markdown
  body="$(printf '%s\n\n## Task\n\n%s\n\n## Agent summary\n\n%s\n\n## Run\n\n- job: `%s`\n- runner: %s\n- model: %s\n- %s\n' \
    "Opened by eumaeus. Review before merging." "$TASK" "${AGENT_SUMMARY:-_(none)_}" "$JOB_ID" "$RUNNER" "${MODEL:-default}" "${COST_LINE:-no cost data}")"
  if PR_URL="$(gh pr create --repo "$REPO" --base "$BASE_BRANCH" --head "$BRANCH" --title "$title" --body "$body" 2>/tmp/pr.err)"; then
    log "pr $PR_URL"
  else
    log "pr create failed: $(cat /tmp/pr.err)"; PR_URL=""
  fi
fi

extra=",\"branch\":\"$BRANCH\",\"commit\":\"$(git rev-parse HEAD)\",\"files\":$(git diff --name-only HEAD~1 | jq -R . | jq -sc .)"
[ -n "$PR_URL" ] && extra="$extra,\"pr_url\":\"$PR_URL\""
emit pushed "$extra"

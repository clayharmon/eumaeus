#!/usr/bin/env bash
# Runs inside the job VM. Clone, run the agent, commit, push one branch.
# Required env: JOB_ID, REPO (owner/name), TASK, GH_TOKEN.
# Optional env: BASE_BRANCH (main), BRANCH (job/$JOB_ID), RUNNER (claude|codex|antigravity|pi|shell), MODEL,
#   GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL (commit identity), OPEN_PR (1 = open a pull request after push).
# Runner credentials: claude ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; codex OPENAI_API_KEY or CODEX_API_KEY;
#   antigravity GEMINI_API_KEY; pi any provider key, e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY.
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
git clone -q --branch "$BASE_BRANCH" "https://github.com/$REPO.git" /work/repo
cd /work/repo
# Existing branch (e.g. a PR to iterate on): build on it. Otherwise start from the base.
if git rev-parse -q --verify "origin/$BRANCH" >/dev/null; then
  git checkout -q -b "$BRANCH" "origin/$BRANCH"
  UPSTREAM="origin/$BRANCH"
  log "checked out existing $BRANCH ($(git rev-parse --short HEAD)), $(git rev-list --count "origin/$BASE_BRANCH..HEAD") commit(s) ahead of $BASE_BRANCH"
else
  git checkout -q -b "$BRANCH"
  UPSTREAM="origin/$BASE_BRANCH"
fi

log "runner=$RUNNER model=${MODEL:-default}"
need() { # need <error-code> VAR... : fail unless at least one VAR is non-empty
  local code="$1"; shift
  for v in "$@"; do [ -n "${!v:-}" ] && return 0; done
  log "runner=$RUNNER needs one of: $*"; emit failed ",\"error\":\"$code\""; exit 3
}
model_arg() { [ -n "$MODEL" ] && printf '%s' "$MODEL"; }

# One log line per interesting agent event, written as the agent works. Non-JSON lines are skipped.
# Claude Code stream-json: system/init, assistant (text + tool_use blocks), user (tool results), result.
narrate_claude() {
  jq -rR --unbuffered '
    fromjson? // empty
    | if .type == "system" and .subtype == "init" then "init model=\(.model // "?")"
      elif .type == "assistant" then
        (.message.content | if type == "array" then . else [] end)[]
        | if .type == "text" then "> " + (.text | gsub("\\s+"; " ") | .[0:200])
          elif .type == "tool_use" then
            "* \(.name) " + (.input | (.command // .file_path // .pattern // .path // .url // .description // tostring)
                              | tostring | gsub("\\s+"; " ") | .[0:160])
          else empty end
      elif .type == "result" then
        "result \(.subtype // "?") turns=\(.num_turns // "?") cost_usd=\(.total_cost_usd // "?") duration_s=\(((.duration_ms // 0) / 1000) | floor)"
      else empty end
    | "[agent] " + .
  ' >&2
}
# Codex exec --json: item.completed (agent_message, command_execution, file_change, reasoning), turn.completed, error.
narrate_codex() {
  jq -rR --unbuffered '
    fromjson? // empty
    | if .type == "item.completed" then
        .item
        | if .type == "agent_message" then "> " + ((.text // "") | gsub("\\s+"; " ") | .[0:200])
          elif .type == "command_execution" then "* bash " + ((.command // "") | gsub("\\s+"; " ") | .[0:160]) + " (exit \(.exit_code // "?"))"
          elif .type == "file_change" then "* edit " + ((.changes // []) | map(.path // "?") | join(", ") | .[0:160])
          elif .type == "reasoning" then empty
          else "- \(.type // "?")" end
      elif .type == "turn.completed" then "result tokens in=\(.usage.input_tokens // "?") out=\(.usage.output_tokens // "?")"
      elif .type == "error" then "error " + ((.message // tostring) | .[0:200])
      else empty end
    | "[agent] " + .
  ' >&2
}

run_agent() {
  case "$RUNNER" in
    claude)
      need no_anthropic_credentials ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
      # stream-json emits one event per line while the agent works; narrate them to the log, keep the final result.
      local args=(-p --output-format stream-json --verbose --dangerously-skip-permissions)
      [ -n "$MODEL" ] && args+=(--model "$MODEL")
      local rc=0
      claude "${args[@]}" "$TASK" | tee /work/runner.jsonl | narrate_claude || rc=${PIPESTATUS[0]}
      [ "$rc" -eq 0 ] || return "$rc"
      jq -c 'select(.type == "result")' /work/runner.jsonl | tail -n 1 > /work/runner.json
      [ -s /work/runner.json ] || { log "claude exited 0 without a result event"; return 5; }
      AGENT_SUMMARY="$(jq -r '.result // ""' /work/runner.json | head -c 4000)"
      COST_LINE="model=$(jq -r '(.modelUsage // {}) | keys | join("+") | if . == "" then "?" else . end' /work/runner.json) cost_usd=$(jq -r '.total_cost_usd // "?"' /work/runner.json) turns=$(jq -r '.num_turns // "?"' /work/runner.json)"
      ;;
    codex)
      need no_openai_credentials CODEX_API_KEY OPENAI_API_KEY
      export CODEX_API_KEY="${CODEX_API_KEY:-$OPENAI_API_KEY}"
      local args=(exec --json --sandbox danger-full-access --skip-git-repo-check --ephemeral -o /work/codex-last.md)
      [ -n "$MODEL" ] && args+=(-m "$MODEL")
      local rc=0
      codex "${args[@]}" "$TASK" | tee /work/runner.jsonl | narrate_codex || rc=${PIPESTATUS[0]}
      [ "$rc" -eq 0 ] || return "$rc"
      AGENT_SUMMARY="$(head -c 4000 /work/codex-last.md 2>/dev/null || true)"
      COST_LINE="$(jq -r 'select(.type=="turn.completed") | .usage | "tokens in=\(.input_tokens) cached=\(.cached_input_tokens // 0) out=\(.output_tokens)"' /work/runner.jsonl | tail -1)"
      ;;
    antigravity)
      need no_gemini_credentials GEMINI_API_KEY
      local args=(-p --output-format json --dangerously-skip-permissions)
      [ -n "$MODEL" ] && args+=(--model "$MODEL")
      agy "${args[@]}" "$TASK" > /work/runner.json || return $?
      [ "$(jq -r '.status // ""' /work/runner.json)" = "SUCCESS" ] || { log "agy status: $(jq -c '{status, error}' /work/runner.json)"; return 5; }
      AGENT_SUMMARY="$(jq -r '.response // ""' /work/runner.json | head -c 4000)"
      COST_LINE="tokens in=$(jq -r '.usage.input_tokens // "?"' /work/runner.json) out=$(jq -r '.usage.output_tokens // "?"' /work/runner.json) turns=$(jq -r '.num_turns // "?"' /work/runner.json)"
      ;;
    pi)
      need no_provider_credentials ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY XAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY
      local args=(-p --no-session --no-approve)
      [ -n "$MODEL" ] && args+=(--model "$MODEL")
      pi "${args[@]}" "$TASK" > /work/runner.txt || return $?
      AGENT_SUMMARY="$(tail -c 4000 /work/runner.txt)"
      COST_LINE="usage not reported by pi print mode"
      ;;
    shell)
      bash -c "$TASK"
      ;;
    *)
      log "unknown runner: $RUNNER"; emit failed ',"error":"unknown_runner"'; exit 2
      ;;
  esac
}

if ! run_agent; then
  rc=$?
  log "runner exited $rc"
  emit failed ",\"error\":\"runner_exit_$rc\""
  exit 4
fi
[ -n "$AGENT_SUMMARY" ] && log "agent: $(printf '%s' "$AGENT_SUMMARY" | head -c 2000)"
[ -n "$COST_LINE" ] && log "$COST_LINE"

# The agent may have committed itself (e.g. a merge). Commit anything it left in the tree, then
# push only if HEAD moved past what the remote already has.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "eumaeus job $JOB_ID" -m "$TASK"
fi
NEW_COMMITS="$(git rev-list --count "$UPSTREAM..HEAD")"
if [ "$NEW_COMMITS" = 0 ]; then
  log "no changes"; emit no_changes; exit 0
fi
git push -q -u origin "$BRANCH"
log "pushed $BRANCH ($NEW_COMMITS new commit(s))"

PR_URL=""
if [ "$OPEN_PR" = "1" ] && PR_URL="$(gh pr view "$BRANCH" --repo "$REPO" --json url -q .url 2>/dev/null)" && [ -n "$PR_URL" ]; then
  log "pr already open: $PR_URL"
elif [ "$OPEN_PR" = "1" ]; then
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

# Files the branch changes relative to the base (three-dot), so a merge from base doesn't list base's files.
extra=",\"branch\":\"$BRANCH\",\"commit\":\"$(git rev-parse HEAD)\",\"files\":$(git diff --name-only "origin/$BASE_BRANCH...HEAD" | jq -R . | jq -sc .)"
[ -n "$PR_URL" ] && extra="$extra,\"pr_url\":\"$PR_URL\""
emit pushed "$extra"

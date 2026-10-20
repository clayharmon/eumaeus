#!/usr/bin/env bash
# Runs inside the job VM. Clone, run the agent, commit, push one branch.
# Required env: JOB_ID, REPO (owner/name), TASK, GH_TOKEN.
# Optional env: BASE_BRANCH (main), BRANCH (job/$JOB_ID), RUNNER (claude|codex|antigravity|pi|shell), MODEL,
#   GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL (commit identity), OPEN_PR (1 = open a pull request after push),
#   PR_ASSIGNEE (GitHub login to assign the PR to), PR_FOOTER (appended to the body of a PR this job opens, e.g.
#   "Closes #12"), PR_BODY (replace = rewrite the open PR's title and body from /work/pr.md, even with no commit).
# Agent runners are asked to write the PR title and body to /work/pr.md (filling the repo's PR template if
# there is one). The PR is opened from that file; without it the body is the task plus the agent's summary.
# PNGs an agent saves in /work/screenshots/ go to the branch eumaeus-screenshots and show in the PR.
# Runner credentials: claude ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN; codex OPENAI_API_KEY or CODEX_API_KEY;
#   antigravity GEMINI_API_KEY; pi any provider key, e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY.
# Output: the dispatcher mounts a host directory at /out; the agent's own output stream is written there and
#   outlives the VM. Without /out (scripts/run-job.sh) it stays in /work.
# Environment (docs/m5-environments.md): SETUP (runs before the agent), SHELL_PREFIX (wraps the agent), CACHE
#   (newline-separated paths kept on the disk), EUMAEUS_TOML=1 when they came from the repo's .eumaeus.toml.
#   An unset SETUP or SHELL_PREFIX falls back to the first environment file the repo has.
# stdout: one JSON line with the outcome, including "usage" once the agent has run. stderr: progress.
set -euo pipefail

: "${JOB_ID:?}" "${REPO:?}" "${TASK:?}" "${GH_TOKEN:?}"
BASE_BRANCH="${BASE_BRANCH:-main}"
BRANCH="${BRANCH:-job/$JOB_ID}"
RUNNER="${RUNNER:-claude}"
MODEL="${MODEL:-}"
OPEN_PR="${OPEN_PR:-1}"
AGENT_SUMMARY=""
COST_LINE=""
USAGE=""
ENV_JSON=""
SETUP_OK=""
OUT=/work; { [ -d /out ] && [ -w /out ]; } && OUT=/out
# /nix is the repo's disk when the dispatcher mounts one; the host clones it after exit, so flush it first.
trap sync EXIT

log() { printf '[job %s] %s\n' "$JOB_ID" "$*" >&2; }
# setup_ok tells the dispatcher this job's disk may become the repo's golden disk.
emit() {
  local extra="${2:-}"
  [ -n "$USAGE" ] && extra="$extra,\"usage\":$USAGE"
  [ -n "$ENV_JSON" ] && extra="$extra,\"env\":$ENV_JSON"
  [ -n "$SETUP_OK" ] && extra="$extra,\"setup_ok\":true"
  printf '{"job_id":"%s","status":"%s"%s}\n' "$JOB_ID" "$1" "$extra"
}

# A repo image (.eumaeus.toml `image`) builds on this one; it has to hand back to the agent user.
if [ "$(id -u)" = 0 ]; then
  log "running as root; a repo Dockerfile must end with USER agent"; emit failed ',"error":"runs_as_root"'; exit 2
fi

git config --global user.name  "${GIT_AUTHOR_NAME:-eumaeus}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-eumaeus@users.noreply.github.com}"
git config --global init.defaultBranch main
gh auth setup-git >/dev/null

log "clone $REPO @ $BASE_BRANCH (image ${EUMAEUS_COMMIT:-unknown})"
# Three tries, 10 s apart: a VM that boots while the host's network is settling has lost a job in 2 s
# on "Could not resolve host: github.com" three times in one day, each before any work was done.
# init and fetch rather than clone: clone ignores a negative refspec, and the screenshots branch stays out. It only
# grows, and no job reads it.
for attempt in 1 2 3 4; do
  if git init -q /work/repo && git -C /work/repo remote add origin "https://github.com/$REPO.git" \
     && git -C /work/repo config --add remote.origin.fetch '^refs/heads/eumaeus-screenshots' \
     && git -C /work/repo fetch -q origin 2>/tmp/clone.err \
     && git -C /work/repo checkout -q -B "$BASE_BRANCH" --track "origin/$BASE_BRANCH" 2>>/tmp/clone.err; then break; fi
  rm -rf /work/repo
  if [ "$attempt" = 3 ]; then cat /tmp/clone.err >&2; log "clone failed 3 times"; emit failed ',"error":"clone_failed"'; exit 2; fi
  log "clone attempt $attempt failed: $(tr -d '\n' < /tmp/clone.err | cut -c1-200); retrying in 10 s"
  sleep 10
done
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

# Repo environment. A detected tool runs from the disk at /nix, which carries Nix, devenv, devbox, mise, and Flox.
DISK=""; mountpoint -q /nix && [ -d /nix/store ] && DISK=1
DETECTED=none; D_SETUP=""; D_SHELL=""
if   [ -f devenv.nix ];              then DETECTED=devenv.nix;  D_SETUP='devenv up -d && devenv processes wait --timeout 120'; D_SHELL='devenv shell --'
elif [ -f devbox.json ];             then DETECTED=devbox.json; D_SETUP='devbox services up -b'; D_SHELL='devbox run --'
elif [ -f .flox/env/manifest.toml ]; then DETECTED=.flox;       D_SHELL='flox activate -s --'  # services start inside the activation
elif [ -f flake.nix ];               then DETECTED=flake.nix;   D_SHELL='nix develop -c'
elif [ -f mise.toml ];               then DETECTED=mise.toml;   D_SHELL='mise exec --'
fi
if [ "$DETECTED" != none ] && [ -z "$DISK" ]; then
  log "env: $DETECTED needs the disk at /nix and this job has none; running without it"
  D_SETUP=""; D_SHELL=""
fi
# A value from .eumaeus.toml is declared: if it fails, the job fails. A detected one is best effort.
SETUP_FROM=detected; [ -n "${SETUP+x}" ] && SETUP_FROM=declared
SHELL_FROM=detected; [ -n "${SHELL_PREFIX+x}" ] && SHELL_FROM=declared
SETUP="${SETUP-$D_SETUP}"
SHELL_PREFIX="${SHELL_PREFIX-$D_SHELL}"
read -ra PREFIX <<< "$SHELL_PREFIX"
FALLBACK=""
env_json() {
  # The dispatcher adds where the disk came from and whether it was promoted.
  jq -cn --argjson toml "$([ "${EUMAEUS_TOML:-}" = 1 ] && echo true || echo false)" --arg detected "$DETECTED" \
    --argjson setup_s "${SETUP_S:-null}" --arg fallback "$FALLBACK" \
    '{toml: $toml, detected: $detected, setup_s: $setup_s, fallback: (if $fallback == "" then null else $fallback end)}'
}
ENV_JSON="$(env_json)"
log "env: ${EUMAEUS_TOML:+.eumaeus.toml, }detected $DETECTED, disk $([ -n "$DISK" ] && echo yes || echo no); setup: ${SETUP:-none}; shell: ${SHELL_PREFIX:-none}"

# A cache path becomes a link into the disk, so what tools leave there is on the next job's disk.
link_cache() {
  local p="${1%/}" src dst
  # shellcheck disable=SC2088  # a literal ~/ prefix, matched here and expanded below
  case "$p" in
    '~/'*) src="$HOME/${p#\~/}"; dst="/nix/eumaeus/cache/home/${p#\~/}" ;;
    /*|*..*) log "cache: skipped $p (use a repo path or ~/path, without ..)"; return 0 ;;
    *)
      if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then log "cache: skipped $p (tracked by git)"; return 0; fi
      src="/work/repo/$p"; dst="/nix/eumaeus/cache/repo/$p"
      printf '/%s\n' "$p" >> .git/info/exclude  # never commit the link
      ;;
  esac
  mkdir -p "$dst" "$(dirname "$src")"
  if [ -e "$src" ] && [ ! -L "$src" ]; then cp -a "$src/." "$dst/" && rm -rf "$src"; fi
  rm -f "$src"
  ln -s "$dst" "$src"
}
if [ -n "$DISK" ]; then
  # shellcheck disable=SC2088  # the tilde is literal; link_cache expands it
  while IFS= read -r p; do [ -n "$p" ] && link_cache "$p"; done < <(printf '~/.cache\n~/.local/share\n%s\n' "${CACHE:-}")
fi

# A detected environment that doesn't come up is dropped, and the job runs as it did before M5. Running the prefix
# once with `true` also installs or builds what the environment needs before the agent starts.
drop_detected() {
  FALLBACK="$1"
  log "env: $1. $DETECTED was detected, not declared, so the job runs without it; .eumaeus.toml makes this an error"
  PREFIX=(); SHELL_PREFIX=""
}
fail_declared() { # fail_declared <error code> <message>
  SETUP_S=$((SECONDS - t0)); ENV_JSON="$(env_json)"
  log "$2 after ${SETUP_S}s"; emit failed ",\"error\":\"$1\""; exit 6
}
t0=$SECONDS
if [ -n "$SETUP" ]; then
  log "setup: $SETUP"; rc=0
  bash -c "$SETUP" >&2 || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$SETUP_FROM" = declared ] && fail_declared "setup_exit_$rc" "setup exited $rc"
    drop_detected "setup exited $rc"
  fi
fi
if [ ${#PREFIX[@]} -gt 0 ]; then
  rc=0
  "${PREFIX[@]}" true >&2 || rc=$?
  if [ "$rc" -ne 0 ]; then
    [ "$SHELL_FROM" = declared ] && fail_declared "shell_exit_$rc" "$SHELL_PREFIX true exited $rc"
    drop_detected "$SHELL_PREFIX true exited $rc"
  fi
fi
SETUP_S=$((SECONDS - t0)); ENV_JSON="$(env_json)"
log "environment ready in ${SETUP_S}s${FALLBACK:+ (without $DETECTED)}"
SETUP_OK=1

log "runner=$RUNNER model=${MODEL:-default}"
need() { # need <error-code> VAR... : fail unless at least one VAR is non-empty
  local code="$1"; shift
  for v in "$@"; do [ -n "${!v:-}" ] && return 0; done
  log "runner=$RUNNER needs one of: $*"; emit failed ",\"error\":\"$code\""; exit 3
}
model_arg() { [ -n "$MODEL" ] && printf '%s' "$MODEL"; }
# The shell prefix puts the repo's tools first on PATH, node included. Run the agent CLI by its path in the image,
# and a node-script CLI (codex, pi) with the image's node, so the repo's node version can't break the agent.
agent_cmd() {
  local p; p="$(readlink -f "$(command -v "$1")")"
  if [ "$(head -c 2 "$p")" = '#!' ] && head -n 1 "$p" | grep -q node; then AGENT=("${PREFIX[@]}" /usr/local/bin/node "$p")
  else AGENT=("${PREFIX[@]}" "$p"); fi
}

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
      agent_cmd claude
      "${AGENT[@]}" "${args[@]}" "$AGENT_TASK" | tee "$OUT/runner.jsonl" | narrate_claude || rc=${PIPESTATUS[0]}
      [ "$rc" -eq 0 ] || return "$rc"
      jq -cR 'fromjson? | select(.type == "result")' "$OUT/runner.jsonl" | tail -n 1 > /work/runner.json
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
      agent_cmd codex
      "${AGENT[@]}" "${args[@]}" "$AGENT_TASK" | tee "$OUT/runner.jsonl" | narrate_codex || rc=${PIPESTATUS[0]}
      [ "$rc" -eq 0 ] || return "$rc"
      AGENT_SUMMARY="$(head -c 4000 /work/codex-last.md 2>/dev/null || true)"
      COST_LINE="$(jq -r 'select(.type=="turn.completed") | .usage | "tokens in=\(.input_tokens) cached=\(.cached_input_tokens // 0) out=\(.output_tokens)"' "$OUT/runner.jsonl" | tail -1)"
      ;;
    antigravity)
      need no_gemini_credentials GEMINI_API_KEY
      local args=(-p --output-format json --dangerously-skip-permissions)
      [ -n "$MODEL" ] && args+=(--model "$MODEL")
      agent_cmd agy
      "${AGENT[@]}" "${args[@]}" "$AGENT_TASK" > "$OUT/runner.json" || return $?
      [ "$(jq -r '.status // ""' "$OUT/runner.json")" = "SUCCESS" ] || { log "agy status: $(jq -c '{status, error}' "$OUT/runner.json")"; return 5; }
      AGENT_SUMMARY="$(jq -r '.response // ""' "$OUT/runner.json" | head -c 4000)"
      COST_LINE="tokens in=$(jq -r '.usage.input_tokens // "?"' "$OUT/runner.json") out=$(jq -r '.usage.output_tokens // "?"' "$OUT/runner.json") turns=$(jq -r '.num_turns // "?"' "$OUT/runner.json")"
      ;;
    pi)
      need no_provider_credentials ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY XAI_API_KEY GROQ_API_KEY MISTRAL_API_KEY
      local args=(-p --no-session --no-approve)
      [ -n "$MODEL" ] && args+=(--model "$MODEL")
      agent_cmd pi
      "${AGENT[@]}" "${args[@]}" "$AGENT_TASK" > "$OUT/runner.txt" || return $?
      AGENT_SUMMARY="$(tail -c 4000 "$OUT/runner.txt")"
      COST_LINE="usage not reported by pi print mode"
      ;;
    shell)
      "${PREFIX[@]}" /bin/bash -c "$TASK"
      ;;
    *)
      log "unknown runner: $RUNNER"; emit failed ',"error":"unknown_runner"'; exit 2
      ;;
  esac
}

# Usage for the result line, as one JSON object. Prints nothing when the runner reports none (pi, shell).
usage_json() {
  case "$RUNNER" in
    claude)
      jq -cR 'fromjson? | select(.type == "result")
        | {cost_usd: .total_cost_usd, turns: .num_turns, duration_s: (((.duration_ms // 0) / 1000) | floor),
           models: ((.modelUsage // {}) | keys)}' "$OUT/runner.jsonl" | tail -n 1
      ;;
    codex)
      jq -cR 'fromjson? | select(.type == "turn.completed") | .usage' "$OUT/runner.jsonl" \
        | jq -sc 'if length == 0 then empty else
            {input_tokens: (map(.input_tokens // 0) | add), cached_input_tokens: (map(.cached_input_tokens // 0) | add),
             output_tokens: (map(.output_tokens // 0) | add)} end'
      ;;
    antigravity)
      jq -c '{input_tokens: .usage.input_tokens, output_tokens: .usage.output_tokens, turns: .num_turns}' "$OUT/runner.json"
      ;;
  esac
}

# Ask agent runners for the PR description. Never for `shell`, whose TASK is a command line.
PR_FILE=/work/pr.md
AGENT_TASK="$TASK"
if [ "$RUNNER" != shell ]; then
  # `|| true`: find exits 1 when .github or docs is missing, and set -e would end the job here.
  PR_TEMPLATE="$(find . .github docs -maxdepth 1 -iname 'pull_request_template.md' 2>/dev/null | head -n1 | sed 's#^\./##' || true)"
  mkdir -p /work/screenshots
  handoff="A headless Chromium is available through \`playwright-cli\`; run \`playwright-cli --help\`. If your change affects what a browser renders, start the app, check the page, and save up to 6 PNG screenshots, 2 MB at most each, to /work/screenshots/. The pull request shows them."
  handoff="$handoff When the work is done, write the pull request description to $PR_FILE: line 1 is the PR title (72 characters max), then a blank line, then the body in Markdown."
  [ -n "$PR_TEMPLATE" ] && handoff="$handoff The repository's PR template is at $PR_TEMPLATE; fill it in."
  if [ "${PR_BODY:-}" = replace ]; then
    handoff="$handoff $PR_FILE is outside the repository, so it is not committed. The harness pushes the branch and opens the pull request from that file, or, when one is already open, replaces its title and body with that file."
  else
    handoff="$handoff $PR_FILE is outside the repository, so it is not committed. The harness pushes the branch and opens the pull request from that file unless one is already open."
  fi
  AGENT_TASK="$TASK"$'\n\n'"---"$'\n'"Hand-off from the eumaeus harness, not from the requester: $handoff"
  log "pr description requested at $PR_FILE${PR_TEMPLATE:+ (template: $PR_TEMPLATE)}${PR_BODY:+ (pr_body=$PR_BODY)}"
fi

# `run_agent || rc=$?` rather than `if ! run_agent`: inside that if, $? is the negated status, always 0.
rc=0
run_agent || rc=$?
USAGE="$(usage_json 2>/dev/null || true)"
if [ "$rc" -ne 0 ]; then
  log "runner exited $rc"
  emit failed ",\"error\":\"runner_exit_$rc\""
  exit 4
fi
[ -n "$AGENT_SUMMARY" ] && log "agent: $(printf '%s' "$AGENT_SUMMARY" | head -c 2000)"
[ -n "$COST_LINE" ] && log "$COST_LINE"

# The agent may have committed itself (e.g. a merge). Commit anything it left in the tree, then
# push only if HEAD moved past what the remote already has. A job with nothing to push goes on to the PR
# section: with PR_BODY=replace it still rewrites the open PR's body.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "eumaeus job $JOB_ID" -m "$TASK"
fi
NEW_COMMITS="$(git rev-list --count "$UPSTREAM..HEAD")"
if [ "$NEW_COMMITS" != 0 ]; then
  git push -q -u origin "$BRANCH"
  log "pushed $BRANCH ($NEW_COMMITS new commit(s))"
else
  log "no changes"
fi

# Screenshots go under $JOB_ID/ on an orphan branch, never on $BRANCH, so a squash merge carries none. Each commit
# holds one job's files, with the branch's last commit as parent: the links name the commit, and a fetch of the
# tip stays small. Another job pushing first rejects the push; fetch its commit and retry, 3 times.
# Saved only after a push: a job that changed nothing has nothing to show.
SHOTS_BRANCH=eumaeus-screenshots; SHOTS_SHA=""; SHOTS=()
save_screenshots() {
  local f name sub root parent commit entries=() p
  for f in /work/screenshots/*.png; do
    [ -f "$f" ] || continue
    if [ "${#SHOTS[@]}" -ge 6 ]; then log "screenshots: kept the first 6"; break; fi
    if [ "$(wc -c < "$f")" -gt 2097152 ]; then log "screenshot $(basename "$f") is over 2 MB: skipped"; continue; fi
    name="$(basename "$f" | tr -c 'A-Za-z0-9._\n-' '_')"
    entries+=("100644 blob $(git hash-object -w "$f")"$'\t'"$name"); SHOTS+=("$name")
  done
  [ "${#SHOTS[@]}" -gt 0 ] || return 0
  sub="$(printf '%s\n' "${entries[@]}" | git mktree)"
  for attempt in 1 2 3 4; do
    parent=""; p=()
    if git fetch -q --depth=1 origin "+refs/heads/$SHOTS_BRANCH:refs/remotes/origin/$SHOTS_BRANCH" 2>/dev/null; then
      parent="$(git rev-parse "origin/$SHOTS_BRANCH")"; p=(-p "$parent")
    fi
    root="$(printf '040000 tree %s\t%s\n' "$sub" "$JOB_ID" | git mktree)"
    commit="$(git commit-tree "$root" "${p[@]}" -m "screenshots from eumaeus job $JOB_ID")"
    if git push -q origin "$commit:refs/heads/$SHOTS_BRANCH" 2>/tmp/shots.err; then
      SHOTS_SHA="$commit"; log "screenshots: ${#SHOTS[@]} on $SHOTS_BRANCH at ${commit:0:8}, try $attempt"; return 0
    fi
    log "screenshots push $attempt failed: $(tr '\n' ' ' < /tmp/shots.err | head -c 300)"
  done
  SHOTS=()
}
[ "$NEW_COMMITS" != 0 ] && save_screenshots
shots_md() {
  printf '### Screenshots\n'
  for n in "${SHOTS[@]}"; do printf '\n![%s](https://github.com/%s/blob/%s/%s/%s?raw=true)\n' "$n" "$REPO" "$SHOTS_SHA" "$JOB_ID" "$n"; done
}

# Sets title and body: from $PR_FILE when the agent wrote it, else the task and the agent's summary; then this job's
# screenshots, its run block, and PR_FOOTER. The same text opens a PR or replaces an open one's.
pr_text() {
  title=""; body=""
  if [ -s "$PR_FILE" ]; then
    title="$(head -n1 "$PR_FILE" | sed 's/^#* *//' | cut -c1-72)"
    body="$(tail -n +2 "$PR_FILE" | sed '1{/^$/d;}')"
    log "pr description from agent ($(wc -l < "$PR_FILE" | tr -d ' ') lines)"
  fi
  [ -n "$title" ] || title="$(printf '%s' "$TASK" | head -n1 | cut -c1-72)"
  if [ -n "$body" ]; then
    # shellcheck disable=SC2016  # backticks are literal markdown
    # The task stays out of the body: job_status holds it, and a squash merge copies the body into the commit.
    run="$(printf '\n\n<details><summary>eumaeus run</summary>\n\n- job: `%s`\n- runner: %s\n- requested model: %s\n- %s\n\n</details>\n' \
      "$JOB_ID" "$RUNNER" "${MODEL:-default}" "${COST_LINE:-no cost data}")"
  else
    # shellcheck disable=SC2016
    body="$(printf '%s\n\n## Task\n\n%s\n\n## Agent summary\n\n%s' \
      "Opened by eumaeus. Review before merging." "$TASK" "${AGENT_SUMMARY:-_(none)_}")"
    # shellcheck disable=SC2016
    run="$(printf '\n\n## Run\n\n- job: `%s`\n- runner: %s\n- requested model: %s\n- %s\n' "$JOB_ID" "$RUNNER" "${MODEL:-default}" "${COST_LINE:-no cost data}")"
  fi
  [ -n "$SHOTS_SHA" ] && body="$body"$'\n\n'"$(shots_md)"
  body="$body$run"
  [ -n "${PR_FOOTER:-}" ] && body="$body"$'\n\n'"$PR_FOOTER"
  return 0
}

# Only a PR that is still open counts: `gh pr view <branch>` also returns a closed or merged one.
PR_URL=""; PR_OPENED=""; PR_EDITED=""
assign=(); [ -n "${PR_ASSIGNEE:-}" ] && assign=(--assignee "$PR_ASSIGNEE")
if [ "$OPEN_PR" = "1" ] && PR_URL="$(gh pr view "$BRANCH" --repo "$REPO" --json url,state -q 'select(.state == "OPEN") | .url' 2>/dev/null)" && [ -n "$PR_URL" ]; then
  log "pr already open: $PR_URL"
  if [ "$NEW_COMMITS" != 0 ] && [ ${#assign[@]} -gt 0 ]; then
    gh pr edit "$PR_URL" --add-assignee "$PR_ASSIGNEE" >/dev/null 2>/tmp/pr.err || log "assign failed: $(cat /tmp/pr.err)"
  fi
  if [ "${PR_BODY:-}" = replace ] && [ -s "$PR_FILE" ]; then
    pr_text
    if gh pr edit "$PR_URL" --title "$title" --body "$body" >/dev/null 2>/tmp/pr.err; then
      log "pr title and body replaced"; PR_EDITED=1
    else
      log "pr edit failed: $(head -c 300 /tmp/pr.err)"
    fi
  elif [ "${PR_BODY:-}" = replace ]; then
    log "pr_body=replace but no $PR_FILE; body unchanged"
  fi
  # Otherwise the body belongs to whoever opened the PR, so this job's screenshots go in a comment.
  if [ -n "$SHOTS_SHA" ] && [ -z "$PR_EDITED" ]; then
    gh pr comment "$PR_URL" --body "$(shots_md)"$'\n\n'"From eumaeus job \`$JOB_ID\`." >/dev/null 2>/tmp/shots.err \
      || log "screenshots comment failed: $(head -c 300 /tmp/shots.err)"
  fi
elif [ "$OPEN_PR" = "1" ] && [ "$NEW_COMMITS" != 0 ]; then
  pr_text
  if PR_URL="$(gh pr create --repo "$REPO" --base "$BASE_BRANCH" --head "$BRANCH" --title "$title" --body "$body" "${assign[@]}" 2>/tmp/pr.err)"; then
    log "pr $PR_URL${PR_ASSIGNEE:+ (assigned to $PR_ASSIGNEE)}"; PR_OPENED=1
  elif [ ${#assign[@]} -gt 0 ] && ! gh pr view "$BRANCH" --repo "$REPO" --json url -q .url >/dev/null 2>&1 \
       && PR_URL="$(gh pr create --repo "$REPO" --base "$BASE_BRANCH" --head "$BRANCH" --title "$title" --body "$body" 2>/tmp/pr2.err)"; then
    log "pr $PR_URL (assign to $PR_ASSIGNEE failed: $(head -c 300 /tmp/pr.err))"; PR_OPENED=1
  else
    log "pr create failed: $(cat /tmp/pr.err /tmp/pr2.err 2>/dev/null | head -c 600)"; PR_URL=""
  fi
fi

extra=""
[ -n "$PR_URL" ] && extra="$extra,\"pr_url\":\"$PR_URL\""
[ -n "$PR_OPENED" ] && extra="$extra,\"pr_opened\":true"
[ "${PR_BODY:-}" = replace ] && extra="$extra,\"pr_edited\":$([ -n "$PR_EDITED" ] && echo true || echo false)"
if [ "$NEW_COMMITS" = 0 ]; then emit no_changes "$extra"; exit 0; fi
# Files the branch changes relative to the base (three-dot), so a merge from base doesn't list base's files.
extra="$extra,\"branch\":\"$BRANCH\",\"commit\":\"$(git rev-parse HEAD)\",\"files\":$(git diff --name-only "origin/$BASE_BRANCH...HEAD" | jq -R . | jq -sc .)"
extra="$extra,\"new_commits\":$NEW_COMMITS"
[ -n "$SHOTS_SHA" ] && extra="$extra,\"screenshots\":$(for n in "${SHOTS[@]}"; do printf 'https://github.com/%s/blob/%s/%s/%s?raw=true\n' "$REPO" "$SHOTS_SHA" "$JOB_ID" "$n"; done | jq -R . | jq -sc .)"
emit pushed "$extra"

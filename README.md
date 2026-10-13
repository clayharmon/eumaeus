# eumaeus

Self-hosted agent harness. Jobs run one per disposable VM on a Mac (Apple `container`),
clone a repo, run a coding agent, push a branch.

Status: M4. A launchd agent runs the dispatcher, which queues jobs, runs up to `EUMAEUS_MAX_CONCURRENT`
(default 2) VMs at once, and serves MCP tools on `127.0.0.1:7777` behind a bearer token. `tailscale serve`
publishes that as HTTPS on the tailnet. Jobs push and open PRs as a GitHub App bot with a one-hour token scoped
to the one repo. Four runners: Claude Code, Codex CLI, Antigravity CLI, pi.

## Layout

- `src/` dispatcher: Node 24, no build step (type stripping). `db.ts` SQLite queue via `node:sqlite`, `runner.ts` one
  `container run` per job, `jobs.ts` scheduler, `mcp.ts` the five tools, `http.ts` stateless streamable-HTTP endpoint.
- `images/job/` job image: Debian bookworm, Node 24, git, gh, ripgrep, jq, Claude Code. Entrypoint is `job.sh`.
- `scripts/run-job.sh` host wrapper for running one job by hand, no dispatcher needed.
- `scripts/mcp-smoke.ts` end-to-end check: lists tools, submits a shell job over MCP, polls it to `pushed`.

## MCP tools

`submit_job(repo, task, runner?, model?, base_branch?, branch?, cpus?, memory?)`, `job_status(job_id)`,
`job_logs(job_id, tail?)`, `cancel_job(job_id)`, `list_jobs(status?, limit?)`, `merge_pr(repo, number, method?, delete_branch?)`.
Job statuses: `queued`, `running`, `pushed`, `no_changes`, `failed`, `cancelled`.

Pass `branch=` to continue an existing PR: the VM checks that branch out instead of starting a new one, and pushes
to it. `merge_pr` merges as the bot and refuses while GitHub reports a conflict; a job on the PR branch whose task is
"merge main and resolve" clears that.

Register with Claude Code once: `claude mcp add -s user -t http eumaeus http://127.0.0.1:7777/mcp`.

## Runners

| `runner` | CLI in the VM | Needs in `secrets.env` | `model` |
|---|---|---|---|
| `claude` | `claude -p --output-format json --dangerously-skip-permissions` | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Anthropic model id |
| `codex` | `codex exec --json --sandbox danger-full-access --ephemeral` | `OPENAI_API_KEY` (or `CODEX_API_KEY`) | OpenAI model id |
| `antigravity` | `agy -p --output-format json --dangerously-skip-permissions` | `GEMINI_API_KEY` | Gemini model id |
| `pi` | `pi -p --no-session --no-approve` | any provider key, e.g. `OPENROUTER_API_KEY` | `provider/id` or fuzzy, e.g. `sonnet` |
| `shell` | `bash -c "$TASK"` | nothing | ignored |

`submit_job` refuses up front when the runner's key is missing from the secrets file, so no VM is spent on it.
Permission bypass is on for every runner because the VM is disposable and holds only a repo-scoped token.
Cost is logged for `claude` (dollars) and as token counts for `codex` and `antigravity`; pi's print mode reports none.

## GitHub App (one time)

```
node scripts/github-app-setup.ts    # serves http://localhost:7778; click through GitHub's manifest flow
```

It writes `~/.config/eumaeus/github-app.json` (0600) with the app id, private key, and bot user id, then waits
for you to install the app. The dispatcher reads that file at startup; without it, jobs fall back to your personal
`gh` token and commits show up as you.

## Run

One-shot on any Mac with `container` installed:

```
scripts/setup-mac.sh --serve
```

It starts the container system, installs deps, builds the job image, writes `~/.config/eumaeus/dispatcher.env`
with a fresh `EUMAEUS_AUTH_TOKEN`, installs the launchd agent `me.clayharmon.eumaeus`, and publishes
`https://<host>.<tailnet>.ts.net:7777/mcp` with `tailscale serve`. It prints the `claude mcp add` line to run on
your laptop. By hand:

```
container build -t eumaeus-job:dev -f images/job/Dockerfile images/job
pnpm install
scripts/service.sh install|status|logs|restart|uninstall    # launchd agent; log in ~/Library/Logs/eumaeus/
pnpm start            # foreground instead, no auth unless EUMAEUS_AUTH_TOKEN is exported
pnpm smoke [url]      # submits a shell job and polls it; sends the token from dispatcher.env
```

## Moving it to the mini

Deployed 2026-10-13 to a Mac mini. The dispatcher there listens on
`127.0.0.1:7777` and `tailscale serve` exposes that one port as `https://<mini>.<tailnet>.ts.net:7777`.
Other services on the mini can use 443 or their own ports.

Steps, as run. Everything except step 2 works over ssh from the laptop.

1. Mini: sign in to Tailscale, turn on Remote Login, `ssh-copy-id` the laptop key.
2. Mini, needs sudo: `installer -pkg container-1.5.0-installer-signed.pkg -target /` and
   `pmset -a sleep 0 disksleep 0 autorestart 1 womp 1`.
3. Mini: mise with node 24, `corepack enable pnpm` (the repo pins `pnpm@10.30.2` in `packageManager`).
4. Clone with the laptop's agent forwarded (`ssh -A`) if the mini's own key is not loaded: the repo is private.
5. `scp ~/.config/eumaeus/secrets.env ~/.config/eumaeus/github-app.json mini:.config/eumaeus/` and `chmod 600`.
6. On the mini, `scripts/setup-mac.sh --serve`. 57 s on the first run, image build included.
7. On the laptop, re-point Claude Code at the mini's URL:

```
claude mcp remove eumaeus -s user
claude mcp add -s user -t http eumaeus https://<mini>.<tailnet>.ts.net:7777/mcp -H "Authorization: Bearer <token from the mini's dispatcher.env>"
```

Limit: FileVault is on, so macOS refuses auto-login. After a reboot the mini waits at the unlock screen and
neither the `container` service nor the launchd agent runs until someone logs in at the keyboard. Turning
FileVault off and enabling auto-login removes that wait.

Config is env vars with defaults, see `src/config.ts`: `EUMAEUS_HOST`, `EUMAEUS_PORT`, `EUMAEUS_AUTH_TOKEN`,
`EUMAEUS_DATA`, `EUMAEUS_IMAGE`, `EUMAEUS_MAX_CONCURRENT`, `EUMAEUS_SECRETS`, `EUMAEUS_GITHUB_APP`, `EUMAEUS_GH_USER`,
`EUMAEUS_OPEN_PR`, `EUMAEUS_CPUS`, `EUMAEUS_MEMORY`, `EUMAEUS_JOB_TIMEOUT_MIN`.

Secrets for the agent go in `~/.config/eumaeus/secrets.env` (`ANTHROPIC_API_KEY=...` or
`CLAUDE_CODE_OAUTH_TOKEN=...`). The file is passed to the VM with `--env-file` and never copied into the image.

## Job image

- `git` clones the repo and commits the job's work.
- `gh` opens pull requests and talks to the GitHub API.
- `ripgrep` (`rg`) searches code quickly.
- `jq` parses and filters JSON.

## Limits

- Each job gets a GitHub App installation token scoped to its repo, valid one hour. The app is installed on
  all repos of the account; narrow that on the app's settings page if you want.
- Secrets reach the VM through a `0600` env file that exists only while the job runs. The task text is on argv.
- The PR body carries the task, the agent's own summary, runner, model, cost, and turn count.
- Antigravity in the VM uses the Gemini API key provider only (no Google account login inside a VM).
- `/mcp` requires the bearer token from `dispatcher.env`; `/healthz` is open. The dispatcher binds to localhost
  only; the tailnet sees it through `tailscale serve`, which is tailnet-only (no Funnel).
- The smoke test opens a real PR on the target repo each run. Close it or point the smoke at a scratch repo.
- Jobs time out after 60 minutes. A dispatcher restart marks in-flight jobs `failed` and removes their VMs.

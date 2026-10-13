# eumaeus

Self-hosted agent harness. Jobs run one per disposable VM on a Mac (Apple `container`),
clone a repo, run a coding agent, push a branch.

Status: M1. A dispatcher queues jobs, runs up to `EUMAEUS_MAX_CONCURRENT` (default 2) VMs at once, and exposes
MCP tools over HTTP on `127.0.0.1:7777`. No GitHub App yet, no tailnet bind, not a launchd service yet.

## Layout

- `src/` dispatcher: Node 24, no build step (type stripping). `db.ts` SQLite queue via `node:sqlite`, `runner.ts` one
  `container run` per job, `jobs.ts` scheduler, `mcp.ts` the five tools, `http.ts` stateless streamable-HTTP endpoint.
- `images/job/` job image: Debian bookworm, Node 24, git, gh, ripgrep, jq, Claude Code. Entrypoint is `job.sh`.
- `scripts/run-job.sh` host wrapper for running one job by hand, no dispatcher needed.
- `scripts/mcp-smoke.ts` end-to-end check: lists tools, submits a shell job over MCP, polls it to `pushed`.

## MCP tools

`submit_job(repo, task, runner?, model?, base_branch?, cpus?, memory?)`, `job_status(job_id)`, `job_logs(job_id, tail?)`,
`cancel_job(job_id)`, `list_jobs(status?, limit?)`. Job statuses: `queued`, `running`, `pushed`, `no_changes`, `failed`, `cancelled`.

Register with Claude Code once: `claude mcp add -s user -t http eumaeus http://127.0.0.1:7777/mcp`.

## Run

```
container build -t eumaeus-job:dev -f images/job/Dockerfile images/job
pnpm install
pnpm start            # dispatcher on 127.0.0.1:7777; data in ~/.local/share/eumaeus
pnpm smoke            # needs the dispatcher running
```

Config is env vars with defaults, see `src/config.ts`: `EUMAEUS_HOST`, `EUMAEUS_PORT`, `EUMAEUS_AUTH_TOKEN`,
`EUMAEUS_DATA`, `EUMAEUS_IMAGE`, `EUMAEUS_MAX_CONCURRENT`, `EUMAEUS_SECRETS`, `EUMAEUS_GH_USER`, `EUMAEUS_CPUS`,
`EUMAEUS_MEMORY`, `EUMAEUS_JOB_TIMEOUT_MIN`.

Secrets for the agent go in `~/.config/eumaeus/secrets.env` (`ANTHROPIC_API_KEY=...` or
`CLAUDE_CODE_OAUTH_TOKEN=...`). The file is passed to the VM with `--env-file` and never copied into the image.

## Job image

- `git` clones the repo and commits the job's work.
- `gh` opens pull requests and talks to the GitHub API.
- `ripgrep` (`rg`) searches code quickly.
- `jq` parses and filters JSON.

## Limits in M1

- GitHub auth is your personal `gh` token, fetched per job. M2 replaces it with a GitHub App installation token.
- Secrets reach the VM through a `0600` env file that exists only while the job runs. The task text is on argv.
- Runner `claude` only (`shell` for testing). `codex`, `antigravity`, `pi` arrive in M3.
- `/mcp` has no auth unless `EUMAEUS_AUTH_TOKEN` is set, so it binds to localhost. M4 adds the tailnet.
- Jobs time out after 60 minutes. A dispatcher restart marks in-flight jobs `failed` and removes their VMs.

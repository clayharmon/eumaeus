<p align="center"><img src="assets/bot-avatar.png" alt="eumaeus logo, a low-poly boar" width="160"></p>

<h1 align="center">eumaeus</h1>

> “I understand and heed you,” replied Eumaeus; “you need instruct me no further…”
>
> …Eumaeus, therefore, took his sandals, bound them to his feet, and started for the town.
>
> — Homer, *The Odyssey*, Book XVI, translated by Samuel Butler

Send a coding agent a repo and a task over MCP; get back a pull request. Each job runs in its own throwaway Linux VM on a Mac, so the agent can run with permission prompts off without touching your machine or your GitHub login.

Limits:

- Runs on Apple Silicon Macs only. Jobs use Apple's [`container`](https://github.com/apple/container) for VMs.
- Works with GitHub repos only.
- Jobs time out after 60 minutes. Restarting the dispatcher marks in-flight jobs `failed`.

## What a job does

1. `submit_job(repo, task)` queues the job in SQLite and returns its id at once.
2. The dispatcher boots a VM from the job image. At most `EUMAEUS_MAX_CONCURRENT` (default 2) run at a time.
3. The VM clones the repo, runs the agent on the task, commits, and pushes `job/<id>`.
4. It opens a PR with the title and body the agent wrote to `/work/pr.md`, using the repo's PR template if it has one.
5. The VM is deleted. The pushed branch, the PR, and the job log are all that remain.

The VM gets a GitHub App installation token scoped to that one repo and valid for one hour. Agent API keys reach it through a `0600` env file that exists only while the job runs.

## Setup

You need Apple [`container`](https://github.com/apple/container/releases), Node 24, and pnpm. `tailscale` is optional.

1. Put agent keys in `~/.config/eumaeus/secrets.env`, one `KEY=value` per line. [Runners](#runners) lists the key each agent needs.
2. Run `node scripts/github-app-setup.ts`, open `http://localhost:7778`, and click through GitHub's app creation. Install the app on the repos jobs may push to. This writes `~/.config/eumaeus/github-app.json`.
3. Run `scripts/setup-mac.sh`. It starts the container system, builds the job image, writes a new `EUMAEUS_AUTH_TOKEN` to `~/.config/eumaeus/dispatcher.env`, and installs a launchd agent. Add `--serve` to publish the endpoint on your tailnet with `tailscale serve`.
4. Register the server with your MCP client, using the token from `dispatcher.env`:

```sh
claude mcp add -s user -t http eumaeus http://127.0.0.1:7777/mcp -H "Authorization: Bearer <token>"
```

`pnpm smoke <owner/repo>` checks the whole path. It opens a real PR, so point it at a scratch repo.

Without a GitHub App, jobs use your `gh` token instead. That token has your full scope and the commits show up as you.

## MCP tools

| Tool | What it does |
|---|---|
| `submit_job(repo, task, runner?, model?, base_branch?, branch?, cpus?, memory?)` | Queues a job. Pass `branch` to push to an existing PR branch. |
| `job_status(job_id)` | Returns `queued`, `running`, `pushed`, `no_changes`, `failed`, or `cancelled`, plus the PR URL. |
| `job_logs(job_id, tail?)` | Tails the log. `claude` and `codex` add one `[agent]` line per tool call as they run. |
| `cancel_job(job_id)` | Cancels a queued job, or stops a running one and removes its VM. |
| `list_jobs(status?, limit?)` | Lists recent jobs, newest first. |
| `merge_pr(repo, number, method?, delete_branch?)` | Merges as the bot. Refuses on a conflict; a job on the PR branch can resolve it. |

## Runners

| `runner` | Agent | Key in `secrets.env` | `model` |
|---|---|---|---|
| `claude` (default) | Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Anthropic model id |
| `codex` | Codex CLI | `OPENAI_API_KEY` or `CODEX_API_KEY` | OpenAI model id |
| `antigravity` | Antigravity CLI | `GEMINI_API_KEY` | Gemini model id |
| `pi` | pi | any provider key, e.g. `OPENROUTER_API_KEY` | `provider/id`, or a name like `sonnet` |
| `shell` | `bash -c "$TASK"` | none | ignored |

`submit_job` refuses up front when the runner's key is missing. Every PR gets a collapsed block with the job id, runner, model, and cost (`claude` only).

## Configuration

The launchd agent reads env vars from `~/.config/eumaeus/dispatcher.env`. Defaults live in `src/config.ts`.

| Variable | Default |
|---|---|
| `EUMAEUS_HOST`, `EUMAEUS_PORT` | `127.0.0.1`, `7777` |
| `EUMAEUS_AUTH_TOKEN` | unset, which turns auth off |
| `EUMAEUS_MAX_CONCURRENT` | `2` |
| `EUMAEUS_CPUS`, `EUMAEUS_MEMORY` | `4`, `4G` per VM |
| `EUMAEUS_JOB_TIMEOUT_MIN` | `60` |
| `EUMAEUS_OPEN_PR` | `1`; `0` pushes the branch only |
| `EUMAEUS_PR_ASSIGNEE` | `EUMAEUS_GH_USER`; empty assigns nobody |
| `EUMAEUS_GH_USER` | `gh`'s active account, used without a GitHub App |
| `EUMAEUS_DATA` | `~/.local/share/eumaeus` |
| `EUMAEUS_SECRETS` | `~/.config/eumaeus/secrets.env` |
| `EUMAEUS_GITHUB_APP` | `~/.config/eumaeus/github-app.json` |
| `EUMAEUS_IMAGE` | `eumaeus-job:dev` |

## Development

- `pnpm start` runs the dispatcher in the foreground. Node 24 strips the types; there is no build step.
- `scripts/service.sh install|status|logs|restart|uninstall` manages the launchd agent. Logs go to `~/Library/Logs/eumaeus/`.
- `scripts/run-job.sh <owner/repo> "<task>" [runner] [model]` runs one job by hand, without the dispatcher.
- `images/job/job.sh` is everything that runs inside the VM.

## License

MIT

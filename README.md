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
- Jobs time out after 60 minutes. Restarting the dispatcher marks in-flight jobs `failed`; `scripts/update.sh` waits for them first.
- [Starting jobs from GitHub](#starting-jobs-from-github) turns issue and PR text into agent instructions. `EUMAEUS_INBOX_USERS` is the only gate: an issue a stranger wrote becomes a task once a listed user labels it. The VM's token can push to any branch of its repo for an hour, the default branch included unless branch protection stops it. Protect the default branch on repos the inbox watches.
- The inbox needs the GitHub App with Issues read and write, and it mints tokens for every repo of an installation. They stay on the host.
- Every VM carries a headless Chromium. One open page took 937 MB of the VM's 4 GB, before the app's dev server and the agent; a repo with a heavy dev server may need `EUMAEUS_MEMORY=6G`. `job_status` shows `result.peak_mem_mb`, the most memory the VM used, sampled every 2 s, so `memory` can be set from a measurement.
- The commit status `eumaeus/ci` repeats what the agent wrote to `/work/ci.json`. It is not an independent run, and a branch rule that requires it is satisfied by the agent's own claim.

## What a job does

1. `submit_job(repo, task)` queues the job in SQLite and returns its id at once.
2. The dispatcher boots a VM from the job image. At most `EUMAEUS_MAX_CONCURRENT` (default 2) run at a time. With `EUMAEUS_MEMORY_BUDGET` set, say `12G` on a 16 GB Mac, a job also waits until its memory limit fits beside the running jobs' limits; a 4G job starts beside an 8G one while a second 8G job waits. `/healthz` shows `memory.in_use_mb`, and `submit_job` refuses a `memory` over the budget.
3. The VM clones the repo, sets up the repo's [environment](#environments), runs the agent on the task, commits, and pushes `job/<id>`.
4. It opens a PR with the title and body the agent wrote to `/work/pr.md`, using the repo's PR template if it has one. Screenshots the agent saved show in the body; see [Browser](#browser). A job on a branch whose PR is already open leaves the body alone, unless it was submitted with `pr_body: "replace"`: then its `pr.md` becomes the PR's title and body, with the job's own screenshots and run block, and it does so even when it pushed nothing.
5. The VM is deleted. The pushed branch, the PR, the job log, the agent's transcript, and the repo's disk are all that remain. Logs and transcripts stay in `~/.local/share/eumaeus` until you delete them.
6. The dispatcher watches [CI](#ci) on the pushed commit and can send a failure to a follow-up job.

The VM gets a GitHub App installation token scoped to that one repo and valid for one hour. Agent API keys reach it through a `0600` env file that exists only while the job runs.

## Setup

You need Apple [`container`](https://github.com/apple/container/releases), Node 24, and pnpm. `tailscale` is optional.

1. Put agent keys in `~/.config/eumaeus/secrets.env`, one `KEY=value` per line. [Runners](#runners) lists the key each agent needs.
2. Run `node scripts/github-app-setup.ts`, open `http://localhost:7778`, and click through GitHub's app creation. Install the app on the repos jobs may push to. This writes `~/.config/eumaeus/github-app.json`.
3. Run `scripts/setup-mac.sh`. It starts the container system, builds the job image and the template disk, writes a new `EUMAEUS_AUTH_TOKEN` to `~/.config/eumaeus/dispatcher.env`, and installs a launchd agent. Add `--serve` to publish the endpoint on your tailnet with `tailscale serve`.
4. Register the server with your MCP client, using the token from `dispatcher.env`:

```sh
claude mcp add -s user -t http eumaeus http://127.0.0.1:7777/mcp -H "Authorization: Bearer <token>"
```

`pnpm smoke <owner/repo>` checks the whole path. It opens a real PR, so point it at a scratch repo.

Without a GitHub App, jobs use your `gh` token instead. That token has your full scope and the commits show up as you.

### Updating

`scripts/update.sh` runs `git pull --ff-only` and `pnpm install`, pauses new jobs, waits for running jobs to finish, rebuilds the job image, and restarts the service. Queued jobs start once the new dispatcher is up. It works over a non-interactive ssh session, such as `ssh -A host 'cd ~/projects/eumaeus && scripts/update.sh'`; the `-A` forwards your agent for the pull when the host has no GitHub key of its own. `/healthz` reports `commit` for the dispatcher and `image_commit` for the job image, and each job log names the image commit on its clone line.

## Environments

A job can only run a repo's checks if the VM has the repo's tools. Each repo gets a disk, mounted at `/nix`, that holds Nix, the environment tools, and the paths the repo asks to keep. The repo says how to use it, with its own environment file or a `.eumaeus.toml`.

Without `.eumaeus.toml`, the first of these files in the repo root decides:

| File | Before the agent | Around the agent |
|---|---|---|
| `devenv.nix` | `devenv up -d && devenv processes wait --timeout 120` | `devenv shell --` |
| `devbox.json` | `devbox services up -b` | `devbox run --` |
| `.flox/env/manifest.toml` | nothing; services start inside the activation | `flox activate -s --` |
| `flake.nix` | nothing | `nix develop -c` |
| `mise.toml` | nothing | `mise exec --` |

A detected file is best effort. eumaeus runs its setup, then its prefix once with `true`; if either fails, the job runs without the environment, as it would with no file, and `result.env.fallback` says what failed.

`.eumaeus.toml` overrides either column and lists paths to keep between jobs. A value it sets is strict: a failing `setup` or prefix fails the job with `setup_exit_<n>` or `shell_exit_<n>`. `setup = ""` and `shell = ""` turn off what was detected. Every key is optional, and an unknown key fails the job before a VM boots:

```toml
setup = "nix develop -c bash scripts/pg-start.sh"   # runs once, before the agent
shell = "nix develop -c"                            # prefix on the agent command
cache = ["target", "~/.cargo"]                      # repo paths or ~/ paths kept on the disk
image = ".eumaeus/Dockerfile"                       # optional: apt packages, see below
```

A repo that needs packages from apt can name a Dockerfile with `image`. It has to build on the job image and hand back to the agent user:

```dockerfile
ARG BASE
FROM $BASE
USER root
RUN apt-get update && apt-get install -y --no-install-recommends figlet && rm -rf /var/lib/apt/lists/*
USER agent
```

The dispatcher builds it before the VM boots, with that one file as the whole build context, so `COPY` from the repo doesn't work. The tag hashes the Dockerfile and the job image, so the image is rebuilt only when one of them changes; a one-package build took 20 s, and a later job reused it. Each repo keeps its 3 most recently used images. A Dockerfile that doesn't start `FROM $BASE` fails the job before building, and one that ends as root fails it with `runs_as_root`. `result.env.image` names the image a job booted.

`~/.cache` and `~/.local/share` are always kept, which covers mise's installs. A cache path in the repo is added to `.git/info/exclude`, so it is never committed.

How the disk carries over:

- Every job boots on an APFS clone of its repo's last disk. Cloning a 3.2 GB disk takes 3 ms and no extra space.
- A job whose setup worked replaces the repo's disk when it ends, even if the agent failed. A cancelled or timed-out job, or a failed setup, leaves it unchanged.
- Two jobs on one repo run on separate clones. When both finish, the later one's disk wins.
- A repo's first job boots on the template disk: Nix 2.35.3, devenv, devbox, mise, and Flox, 2.4 GB, built once by `setup-mac.sh` in about 70 s.
- `job_status` shows `result.env`: the file that decided, seconds until the environment was ready, `fallback` when a detected file failed, whether the disk came from the repo or the template, and whether it was promoted.

Limits:

- A job can leave anything on its repo's disk, including a modified tool, and the next job on that repo runs with it. Disks never cross repos. `reset_cache(repo)` deletes a repo's disk; its next job starts from the template.
- A disk only grows while it lives: ext4 doesn't hand freed blocks back to the sparse file. Three rules delete disks instead, each turned off by setting it to 0:
  - Before a job, its repo's disk is reset when it holds more than `EUMAEUS_DISK_MAX_GB` (40) on the host.
  - Before a job, while the Mac has less than `EUMAEUS_DISK_FREE_GB` (15) free, the biggest disks are reset first.
  - Once a day, disks no job has started on for `EUMAEUS_DISK_IDLE_DAYS` (30) are deleted.

  A reset disk's next job starts from the template, so it runs cold once. `node scripts/disk.ts ls` shows each disk's size and last job. The template is rebuilt by `update.sh` when eumaeus pins a new Nix version.
- Cloning relies on `container` 1.5 storing a volume as one image file on the host. That is not a documented interface. If it changes, jobs run without a disk and the log says why.
- Nix runs single-user without its build sandbox; the VM lacks the namespaces the sandbox needs.

## CI

After a job pushes, the dispatcher watches the checks on that commit: GitHub check runs, which include Actions, and commit statuses. It polls every 30 s from the host, so a 15-minute CI run holds no VM and no job slot. A restart resumes the watch.

`job_status` shows `ci.status`:

| Status | Meaning |
|---|---|
| `pending` | checks are still running |
| `success` | every check passed, was skipped, or was neutral |
| `failure` | a check failed; `ci.followup` names the fix job when one was sent |
| `none` | no check or status 5 min after the push |
| `timeout` | checks still running after `EUMAEUS_CI_TIMEOUT_MIN` (60) |
| `unavailable` | the GitHub App can't read checks; see below |

When a check fails and the job has fix attempts left, eumaeus submits a follow-up job on the same branch, with the same runner and model. Its task names the failing checks and carries their annotations and the Actions log up to the last error, then the original task. The follow-up is watched too, with one attempt fewer.

- `submit_job(ci_fix: n)` sets the attempts for one job, and `EUMAEUS_CI_FIX` (default 1) sets the default. 0 watches without fixing, for callers that handle CI themselves.
- `shell` jobs are watched and never fixed.
- A cancelled or stale check is recorded, not sent for a fix.

A job can report the CI it ran itself, for a repo with Actions off. The agent writes `/work/ci.json` as `{"state": "success", "description": "7/7 steps, 1,077 vitest and 783 cargo tests"}`, with `state` `success` or `failure` and an optional `sha`; agent runners are told so. After the push, or on the branch head a `no_changes` job found, the job posts it as the commit status `eumaeus/ci`, with the description cut at 140 characters and the PR as its link. The status goes on the commit the job pushed, which may include what the agent left uncommitted; when the agent's `sha` names another commit, the description starts `agent tested <sha>;`. The result shows `ci_reported: {state, sha, description}`, or `ci_reported: {error}` when the state is invalid or the post fails; the push stands either way. The watcher reads it like any status, so `ci.status` settles 30 to 60 s after the push, and a `failure` with `ci_fix` above 0 gets a fix job whose task is the description. It is the agent's claim, not a run; see Limits.

The GitHub App needs read access to Checks and Actions and write access to Commit statuses. `node scripts/github-app-setup.ts` asks for it on a new app. An app created before this change lacks it: on the app's settings page, under Permissions & events, set Checks and Actions to Read-only and Commit statuses to Read and write, save, then accept the new permissions on the installation, which GitHub links to by email. Without the write, the status post gets a 403, which lands in `ci_reported.error`.

## Chains

`submit_job(after: <job id or ids>)` holds a job until the jobs it names have ended, on any repo or branch, up to 20 of them. It starts once each ended with a status in `after_status`, default `["pushed", "no_changes"]`. If one ends with another status, the waiting job ends `cancelled` with the error `after <id> ended <status>`, and so does every job waiting on it, without booting a VM. A job that names a job that doesn't exist is refused and nothing is queued. A job submitted behind one that already ended badly is cancelled at once.

- `cancel_job` on a chain's head cancels the rest.
- `after_status: ["pushed", "no_changes", "failed"]` runs a job after a failure, for example a job that reports it.
- A dispatcher restart with a running job marks it `failed`, which cancels the jobs waiting on it. `scripts/update.sh` waits for running jobs first.
- A waiting job holds no VM and no slot. The jobs behind it in the queue start ahead of it.

`submit_job(skip_if: <bash command>)` lets a job decide for itself whether the agent is needed. The VM runs the command in the checked-out repo after the clone and before the environment setup, with `gh`, `git`, `jq`, `node`, `GH_TOKEN`, and the `EUMAEUS_*` variables, under a 120 s timeout. Exit 0 ends the job `no_changes` with `result.skipped`, the first line the command printed, before the agent starts, so it costs no agent turns and the repo's disk is left as it was. Any other exit, the timeout's 124 included, runs the job, and the log records the exit code. A skipped job counts as `no_changes` for the jobs waiting on it. A check that needs the repo's own tools doesn't fit here; `gh pr view` does:

```
gh pr view "$EUMAEUS_BRANCH" --repo "$EUMAEUS_REPO" --json comments -q '.comments[].body' | grep -q '^Review: 0 blocking'
```

## Starting jobs from GitHub

Set `EUMAEUS_INBOX_USERS` to a comma-separated list of GitHub logins, and the dispatcher turns what those people do on GitHub into jobs, in every repo the GitHub App is installed on. Empty, the default, turns this off. The mention is `@` plus the app's slug, from `github-app.json`; the dispatcher's log names it at start.

| You do | Where | The job |
|---|---|---|
| Add the label `eumaeus` | an open issue | branches from the default branch, works on the issue, and opens a PR whose body ends `Closes #<n>` |
| Mention the app | a new issue, or a comment on an open issue | the same as the label |
| Mention the app | a PR comment or an inline review comment | commits to the PR's branch what the comment asks; an inline comment's task names its file and line and quotes the last 5 lines of its diff |
| Mention the app | a review's body | one job for the body and every inline comment of that review |

An issue's task is its title, its body, and the comments by listed users. Comments by anyone else stay out. A PR job that follows an eumaeus job on the same branch takes that job's runner and model and appends its task. On a PR a person opened, it runs `claude` with the default model.

The answer goes back where you asked, from the app's bot:

1. 👀 while the job runs. A review has no reactions, so its 👀 goes on the PR.
2. When the job ends, 🚀 for `pushed` or `no_changes`, or 😕 for `failed` or `cancelled`, in the 👀's place.
3. One line: `Opened #14.`, `Pushed 2 commits, up to 1a2b3c4.`, `No changes. Job <id>.`, or `Failed: <error>. Job <id>.` An inline comment gets it as a reply in its thread.

- The label comes off when the job starts. Add it again to retry.
- The label on a PR, a mention on a PR from a fork, and a mention with nothing else on a PR get a reply and start nothing. On an issue, a bare mention means "do this issue".
- A mention in a quoted line (`>`) or in code doesn't count, and neither does one added by editing a comment.
- A trigger from a login not in the list starts nothing. The dispatcher log says so once.
- Each trigger starts one job, across restarts too. A restart neither loses an answer nor posts it twice.
- The first poll of a repo starts from that moment, so turning this on ignores what came before.
- `job_status` shows `trigger`: what kind, its URL, and who caused it.

GitHub can't reach the dispatcher, so it polls. Every `EUMAEUS_INBOX_POLL_S` (60) seconds it reads each repo's open-issue list with the ETag from the last poll. A `304` costs no rate limit; a quiet poll of 50 repos took 1.8 s. When the list changes, it reads label events, comments, inline comments, and the reviews of each PR that changed. A rate-limit response pauses polling until GitHub's reset. `/healthz` `inbox` shows the repos watched, the last poll, triggers waiting for an answer, and the rate limit left per installation.

Setup:

- The app needs Issues read and write, to take labels off and post reactions and comments. `node scripts/github-app-setup.ts` asks for it on a new app. On an existing app, set Issues to Read and write on its settings page, then accept the new permission on the installation.
- Create the label `eumaeus` once in each repo you want to label issues in. eumaeus never creates labels.
- Set `EUMAEUS_INBOX_USERS` on one dispatcher per GitHub App. Two dispatchers with the same app and the list set both submit a job for every trigger.

## Browser

Every VM has Playwright's Chromium and [`playwright-cli`](https://www.npmjs.com/package/@playwright/cli) 0.1.22, so an agent can start the app, open a page at 375 px, and look. Agent runners are told so, and asked to save up to 6 PNG screenshots, 2 MB at most each, to `/work/screenshots/`.

After the push, the job commits them under `<job id>/` on the branch `eumaeus-screenshots`, one job per commit, and the PR body shows them. On a PR that was already open, they go in a comment, or in the body when the job replaces it with `pr_body`. The PR's own branch never holds one, so a squash merge carries none. The images render on github.com and in GitHub Mobile, on private repos too, for anyone who can see the repo. Clones leave `eumaeus-screenshots` out, so it doesn't slow them as it grows.

## MCP tools

| Tool | What it does |
|---|---|
| `submit_job(repo, task, runner?, model?, base_branch?, branch?, cpus?, memory?, ci_fix?, pr_body?, after?, after_status?, skip_if?)` | Queues a job. Pass `branch` to name the branch: an existing one, such as a PR head, is continued, and a new name is created from `base_branch`. Pass `ci_fix` to change how many follow-ups a CI failure may start. Pass `pr_body: "replace"` to have a job on an open PR rewrite the PR's title and body from its `/work/pr.md`. Pass `after` to hold the job until other jobs end, and `skip_if` to let a check decide whether the agent runs; see [Chains](#chains). |
| `job_status(job_id)` | Returns `queued`, `running`, `pushed`, `no_changes`, `failed`, or `cancelled`, plus the PR URL, `report` (the agent's whole last message, uncut), `result.usage` (cost and turns for `claude`, token counts for `codex` and `antigravity`), `result.pr_edited` for a job with `pr_body`, `result.peak_mem_mb` and `mem_total_mb` for every job, `ci` once pushed, and `trigger` for a job started from GitHub. |
| `job_logs(job_id, tail?)` | Tails the log. `claude` and `codex` add one `[agent]` line per tool call as they run. |
| `job_transcript(job_id, tail?, grep?)` | Returns the agent's own output stream, kept after the VM is gone, lines cut at 4,000 characters. Use it to check what the agent actually ran. |
| `cancel_job(job_id)` | Cancels a queued job, or stops a running one and removes its VM. |
| `list_jobs(status?, limit?)` | Lists recent jobs, newest first. |
| `reset_cache(repo)` | Deletes the repo's disk. Its next job starts from the template. |
| `merge_pr(repo, number, method?, delete_branch?)` | Merges as the bot. Refuses on a conflict; a job on the PR branch can resolve it. |

## Runners

| `runner` | Agent | Key in `secrets.env` | `model` |
|---|---|---|---|
| `claude` (default) | Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | Anthropic model id |
| `codex` | Codex CLI | `OPENAI_API_KEY` or `CODEX_API_KEY` | OpenAI model id |
| `antigravity` | Antigravity CLI | `GEMINI_API_KEY` | Gemini model id |
| `pi` | pi | any provider key, e.g. `OPENROUTER_API_KEY` | `provider/id`, or a name like `sonnet` |
| `shell` | `bash -c "$TASK"` | none | ignored |

`submit_job` refuses up front when the runner's key is missing. Every PR gets a collapsed block with the job id, runner, model, and cost (`claude` only). Every runner, `shell` included, has `EUMAEUS_JOB_ID`, `EUMAEUS_REPO`, and `EUMAEUS_BRANCH` in its environment, and agent runners are told so, so a task can say "name the job" without repeating the id.

## Configuration

The launchd agent reads env vars from `~/.config/eumaeus/dispatcher.env`. Defaults live in `src/config.ts`.

| Variable | Default |
|---|---|
| `EUMAEUS_HOST`, `EUMAEUS_PORT` | `127.0.0.1`, `7777` |
| `EUMAEUS_AUTH_TOKEN` | unset, which turns auth off |
| `EUMAEUS_MAX_CONCURRENT` | `2` |
| `EUMAEUS_CPUS`, `EUMAEUS_MEMORY` | `4`, `4G` per VM |
| `EUMAEUS_MEMORY_BUDGET` | empty, which turns it off; e.g. `12G`: jobs start only while their memory limits fit under it. `EUMAEUS_MEMORY` over it stops the dispatcher at start |
| `EUMAEUS_JOB_TIMEOUT_MIN` | `60` |
| `EUMAEUS_OPEN_PR` | `1`; `0` pushes the branch only |
| `EUMAEUS_PR_ASSIGNEE` | `EUMAEUS_GH_USER`; empty assigns nobody |
| `EUMAEUS_GH_USER` | `gh`'s active account, used without a GitHub App |
| `EUMAEUS_DATA` | `~/.local/share/eumaeus` |
| `EUMAEUS_SECRETS` | `~/.config/eumaeus/secrets.env` |
| `EUMAEUS_GITHUB_APP` | `~/.config/eumaeus/github-app.json` |
| `EUMAEUS_IMAGE` | `eumaeus-job:dev` |
| `EUMAEUS_CI_FIX` | `1` follow-up job per pushed job when its CI fails; `0` watches only |
| `EUMAEUS_CI_TIMEOUT_MIN` | `60` |
| `EUMAEUS_INBOX_USERS` | empty, which turns [starting jobs from GitHub](#starting-jobs-from-github) off |
| `EUMAEUS_INBOX_POLL_S` | `60` |
| `EUMAEUS_DISK_MAX_GB`, `EUMAEUS_DISK_FREE_GB`, `EUMAEUS_DISK_IDLE_DAYS` | `40`, `15`, `30`; see [Environments](#environments) |
| `EUMAEUS_DISK_SIZE` | `64G` per repo disk; the image file is sparse, so it takes only what jobs write |

## Development

- `pnpm start` runs the dispatcher in the foreground. Node 24 strips the types; there is no build step.
- `scripts/service.sh install|status|logs|restart|uninstall` manages the launchd agent. Logs go to `~/Library/Logs/eumaeus/`.
- `scripts/run-job.sh <owner/repo> "<task>" [runner] [model]` runs one job by hand, without the dispatcher.
- `scripts/build-image.sh [image]` builds the job image with the checkout's commit stamped into it.
- `node scripts/disk.ts template [--if-stale]|ls|reset <owner/name>` builds the template disk, lists disks with free space and the limits, or deletes one.
- [`clayharmon/eumaeus-fixtures`](https://github.com/clayharmon/eumaeus-fixtures) has one branch per environment file, used to test them, and `web`, a page whose button overflows at 375 px.
- `images/job/job.sh` is everything that runs inside the VM.

## License

MIT

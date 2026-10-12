# eumaeus

Self-hosted agent harness. Jobs run one per disposable VM on a Mac (Apple `container`),
clone a repo, run a coding agent, push a branch.

Status: M0. One job runs by hand from `scripts/run-job.sh`. No queue, no MCP server, no GitHub App yet.

## Layout

- `images/job/` job image: Debian bookworm, Node 24, git, gh, ripgrep, jq, Claude Code. Entrypoint is `job.sh`.
- `scripts/run-job.sh` host wrapper: builds the env, runs one `container`, exits with the job's status.

## Run

```
container build -t eumaeus-job:dev -f images/job/Dockerfile images/job
scripts/run-job.sh clayharmon/eumaeus "Create jobs/hello.md with the output of uname -r" claude
```

Secrets for the agent go in `~/.config/eumaeus/secrets.env` (`ANTHROPIC_API_KEY=...` or
`CLAUDE_CODE_OAUTH_TOKEN=...`). The file is passed to the VM with `--env-file` and never copied into the image.

## Limits in M0

- GitHub auth is your personal `gh` token, read at run time. M2 replaces it with a GitHub App installation token minted per job.
- Runner `claude` only. `codex`, `antigravity`, `pi` arrive in M3.
- Each VM gets 4 CPUs and 4 GB unless you set `CPUS` and `MEMORY`.

# eumaeus

A dispatcher in `src/` runs coding agents in Apple `container` VMs and opens PRs. Node 24 strips the types, so there
is no build step. `images/job/job.sh` is everything that runs inside a VM. `README.md` is the user docs, and
`docs/m<N>-*.md` are milestone plans.

- Run `pnpm typecheck` before every commit. There is no test suite; each plan step has a Check that runs real jobs.
- A step's commit subject is `M<N> step <n>: <what changed>`. Its body states the Check's evidence: job ids, timings,
  log lines. `git log` shows the style.
- Prose in docs, commits, and PRs follows the writing rules in `~/.claude/CLAUDE.md`.

## Dev loop

- Build the job image once per `job.sh` or Dockerfile change: `scripts/build-image.sh eumaeus-job:dev-<tag>`.
- Run a dev dispatcher from this checkout, in the background with its output in a file:
  `EUMAEUS_DATA=~/.local/share/eumaeus-<tag> EUMAEUS_IMAGE=eumaeus-job:dev-<tag> EUMAEUS_PORT=7778 pnpm start`.
  Restart it after a `src/` change; `pnpm dev` restarts on every edit and kills running jobs. Leave
  `EUMAEUS_INBOX_USERS` unset: the mini's inbox is on, and two inboxes submit every trigger twice.
- Call its tools: `node scripts/mcp-call.ts http://127.0.0.1:7778/mcp <tool> '<json>'`.
- Check jobs go to `clayharmon/eumaeus-fixtures`. A dev data dir has no template disk until
  `EUMAEUS_DATA=... node scripts/disk.ts template` (about 70 s, 2.4 GB); the fixtures checks don't need it.
- The `eumaeus` MCP tool in Claude Code is the mini, the production dispatcher: `ssh clays-mac-mini`, checkout
  `~/projects/eumaeus`, `EUMAEUS_MAX_CONCURRENT=1`, inbox on, another VM holding 8 GB of its 16. Never run checks
  there. Deploy after a push with `ssh -A clays-mac-mini 'cd ~/projects/eumaeus && scripts/update.sh'`, only when
  Clay says so. The `-A` matters: the mini has no GitHub key for `clayharmon`, and the pull uses the laptop's agent.

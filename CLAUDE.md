# eumaeus

A dispatcher in `src/` runs coding agents in Apple `container` VMs and opens PRs. Node 24 strips the types, so there
is no build step. `images/job/job.sh` is everything that runs inside a VM. `README.md` is the user docs, and
`docs/m<N>-*.md` are milestone plans.

- Run `pnpm typecheck` before every commit. There is no test suite; each plan step has a Check that runs real jobs.
- A step's commit subject is `M<N> step <n>: <what changed>`. Its body states the Check's evidence: job ids, timings,
  log lines. `git log` shows the style.
- Prose in docs, commits, and PRs follows the writing rules in `~/.claude/CLAUDE.md`.

## Current milestone

`docs/m8-unattended-queue.md`. "Go" means: build the first step that has no Results subsection, run its Check on the
dev dispatcher below, write its Results subsection in the shape of the M7 doc's, commit, and take the next step.
Stop and ask before step 4's GitHub App permission change, before step 8 (it has a condition in the doc), and
before any deploy to the mini.

## Dev loop

- Build the job image once per `job.sh` or Dockerfile change: `scripts/build-image.sh eumaeus-job:m8`.
- Run the dispatcher from this checkout, in the background with its output in a file:
  `EUMAEUS_DATA=~/.local/share/eumaeus-m8 EUMAEUS_IMAGE=eumaeus-job:m8 EUMAEUS_PORT=7778 pnpm start`.
  Restart it after a `src/` change; `pnpm dev` restarts on every edit and kills running jobs. Leave
  `EUMAEUS_INBOX_USERS` unset here: the mini's inbox is on, and two inboxes submit every trigger twice.
- Call its tools: `node scripts/mcp-call.ts http://127.0.0.1:7778/mcp <tool> '<json>'`.
- The dev data dir has no template disk, so its jobs run without one. The fixtures checks don't need it. A check that
  needs a repo's environment first runs `EUMAEUS_DATA=~/.local/share/eumaeus-m8 node scripts/disk.ts template`
  (about 70 s, 2.4 GB).
- Check jobs go to `clayharmon/eumaeus-fixtures`. Only step 5's measurement touches `clayharmon/hermesmoney`, and
  it runs on the mini, which holds that repo's warm disk; the laptop has 14 GB free.
- The `eumaeus` MCP tool in Claude Code is the mini, the production dispatcher: `ssh clays-mac-mini`, checkout
  `~/projects/eumaeus`, `EUMAEUS_MAX_CONCURRENT=1`, inbox on. Never run checks there. Deploy after a push with
  `ssh clays-mac-mini 'cd ~/projects/eumaeus && scripts/update.sh'`, only when Clay says so.
- A dispatcher started on 2026-10-13 may still hold port 7777 on the laptop. 7778 avoids it.

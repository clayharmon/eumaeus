# eumaeus

A dispatcher in `src/` runs coding agents in Apple `container` VMs and opens PRs. Node 24 strips the types, so there
is no build step. `images/job/job.sh` is everything that runs inside a VM. `README.md` is the user docs, and
`docs/m<N>-*.md` are milestone plans.

- Run `pnpm typecheck` before every commit. There is no test suite; each plan step has a Check that runs real jobs.
- A step's commit subject is `M7 step <n>: <what changed>`. Its body states the Check's evidence: job ids, timings,
  log lines. `git log` shows the style.
- Prose in docs, commits, and PRs follows the writing rules in `~/.claude/CLAUDE.md`.

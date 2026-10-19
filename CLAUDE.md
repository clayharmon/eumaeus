# eumaeus

A dispatcher in `src/` runs coding agents in Apple `container` VMs and opens PRs. Node 24 strips the types, so there
is no build step. `images/job/job.sh` is everything that runs inside a VM. `README.md` is the user docs, and
`docs/m<N>-*.md` are milestone plans.

- Run `pnpm typecheck` before every commit. There is no test suite; each plan step has a Check that runs real jobs.
- A step's commit subject is `M7 step <n>: <what changed>`. Its body states the Check's evidence: job ids, timings,
  log lines. `git log` shows the style.
- Prose in docs, commits, and PRs follows the writing rules in `~/.claude/CLAUDE.md`.

## Active plan: M7

The plan is `docs/m7-github-inbox.md`, on branch `m7-github-inbox`. Its `Status:` line names the next step.

When the user says "go":

1. `git switch m7-github-inbox`.
2. Read the plan, then the code the next step touches.
3. Build the step, run its Check, and commit. One step is one commit.
4. In that commit, set the plan's `Status:` line to the step after it. Record what the build changed from the plan
   under `## Results` at the end of the plan, the way `docs/m5-environments.md` does.
5. Go on to the next step. Stop when a Check fails and you can't fix it, when a step needs the user, or after step 7.
   Report what was built, each Check's result, and what the user does next.

The user does these, so stop and ask:

- Step 3: set the GitHub App `you-eumaeus` to Issues read and write on its settings page, then accept the new
  permission on the installation.
- Step 6: look at the screenshot in GitHub Mobile.
- After step 7: merge and deploy. Don't merge to `main`, push, or run `scripts/update.sh`.

In the step 7 commit, delete this section and the next one.

## Testing M7 without touching what's running

- The `eumaeus` MCP tools in Claude Code reach the production dispatcher on another Mac, which runs what was last
  deployed there, not this branch. Don't use them to test M7.
- A dispatcher from this checkout may be running on `127.0.0.1:7777` with the image `eumaeus-job:dev`. Leave both
  alone.
- Build M7 images with `scripts/build-image.sh eumaeus-job:m7`.
- One VM, no dispatcher: `IMAGE=eumaeus-job:m7 scripts/run-job.sh <owner/repo> "<task>" [runner]`.
- Test dispatcher, in the background:
  `EUMAEUS_PORT=7787 EUMAEUS_DATA=~/.local/share/eumaeus-m7 EUMAEUS_IMAGE=eumaeus-job:m7 pnpm start`.
  Smoke it with `pnpm smoke <owner/repo> http://127.0.0.1:7787/mcp`. Its data directory has no template disk until
  `EUMAEUS_DATA=~/.local/share/eumaeus-m7 node scripts/disk.ts template`, which takes about 70 s.
- Set `EUMAEUS_INBOX_USERS=clayharmon` only on the test dispatcher.
- gh's active account is `clay-vulcan`. Label, comment, and review on the fixtures repo as `clayharmon`:
  `GH_TOKEN=$(gh auth token -u clayharmon) gh ...`.
- The test repo is `clayharmon/eumaeus-fixtures`, public, one branch per fixture. Jobs there open real PRs; close
  each one once its Check passes.
- `~/.config/eumaeus/secrets.env` holds only `CLAUDE_CODE_OAUTH_TOKEN`, so agent jobs use the `claude` runner.

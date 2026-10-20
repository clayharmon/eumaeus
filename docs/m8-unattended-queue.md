# M8: a queue nobody watches

Status: steps 1 to 5 built, with step 5's hermesmoney numbers pending a run on the mini; steps 6 to 8 planned. Evidence is from the 33 hermesmoney jobs of 2026-10-20, ids `20261020-002321-1929`
to `20261020-004138-2a54`, read with `job_status`, `job_logs`, and `job_transcript`.

## The wave loop queues 33 jobs at night and fixes their output by hand in the morning

`clayharmon/hermesmoney` sends its code work to eumaeus from a Claude Code session, the "wave" loop. For each row of
a plan it queues 4 jobs on the row's branch: a build, a continuation that finishes a build that stopped at its
45-minute mark, a review that posts a PR comment starting `Review: <n> blocking, <m> other`, and a fix that reads
that comment. When several rows build at once, restack jobs follow: each rebases a PR onto the PR below it and
force-pushes, so the stack merges bottom-up. Every job passes `cpus: 8, memory: "8G", ci_fix: 0`, and the agent runs
`mise run ci` itself, because Actions is off in that repo.

On the night of 2026-10-19 that loop built 7 PRs, 829 to 835. The morning after:

- 7 PR bodies had `in job JOBID` or "the VM does not expose its job id" where the ci line should name the job. The
  client filled them by hand.
- Fix and continuation jobs had reported body edits as old text and new text, because a job can't change an open
  PR's body. The client applied them by hand, and PRs 830 to 835 were merged before that happened. PR 832's body
  says no screenshots were posted while its screenshots sit on the `shots` branch.
- 5 of the 7 continuations found nothing to do. Each had booted a VM, run setup (7 s to 223 s), and started an
  agent ($0.10 to $0.15) to find that out.
- The end of job `20261020-002615-d4c9`'s report could not be read. `job.sh` logs the last message cut at 2,000
  characters, and `job_transcript` cuts lines at 4,000.
- Each PR page showed no check. `src/ci.ts` records `none` for every push on a repo without Actions, and the only
  proof of CI was a line the agent wrote.
- Every job asked for 8G. Nothing reports what a job used, so the client can't tell whether 4G or 6G would do.

The day before, 2026-10-19, a docs commit pushed to `main` broke a git-ancestry check the client writes into every
stacked build, and 6 queued jobs ended within 30 seconds, starting with `20261019-121336-e448`. The check exists
because nothing in eumaeus orders jobs on different branches.

## Every gap is a decision a person used to make between jobs

eumaeus's model of a job is a task in and a PR out, and someone reading `job_status` in between. That someone decided
whether the continuation was needed, copied the body edits, filled the ci line, and chose the next job. The wave loop
has no one in between: it queues all 33 at once and reads the results at breakfast.

Each item in the list above is that absent person:

| The person used to | The loop does instead | Cost on 2026-10-20 |
|---|---|---|
| decide whether the next job is needed | queue it anyway | 5 VMs, 5 setups, 5 agent starts |
| hold the stacked build until the parent's fix landed | write a git check into the brief | 6 jobs dead in 30 s |
| paste the body edits into the PR | merge with stale bodies | 6 PRs |
| read the job id off the terminal | write `JOBID` | 7 ci lines by hand |
| read the whole report | read 2,000 characters | 1 report cut |
| glance at CI on the PR page | trust a line in the body | 8 merges with no check |
| pick a VM size | pass 8G | unknown |

## Requirements

- A client that passes none of the new parameters sees today's behavior. Every default is the current behavior.
- A chain of jobs stops at its first break without booting a VM for the rest.
- A job that has nothing to do ends before the agent starts, so it costs no agent turns.
- What the agent says about its own CI is labeled as the agent's claim, on GitHub and in the README.
- Every new number lands in `job_status`, and what `list_jobs` shows stays small.
- Runners change only in their environment and the hand-off text. `ci_fix` and the inbox stay as they are.

## A job's outcome is a record, and the next job reads it instead of a person

**Record:** what a job leaves behind: its status, its result JSON, its log, its transcript, the branch head, and the
PR. Today the record is for a person. M8 makes it enough for the next job and for the scheduler.

The eight features split in two. Five add to the record: the job's id in the agent's environment, the agent's whole
last message, a replaced PR body, a commit status on the pushed commit, and the VM's peak memory. Three read a record
to decide without a person: `after` reads another job's status, `skip_if` reads GitHub before the agent starts, and
the memory budget reads each job's memory limit.

## The agent learns its own job id from the environment

Agents wrote `in job JOBID` into PR bodies because nothing told them the id. The brief says the agent in job
`20261020-002321-1929` ran `env | grep -i "eumaeus\|job"` and found nothing. Its transcript shows why: the command
ended in `| head`, and the multi-line `TASK` value filled the 10 lines. `JOB_ID` was in the environment; `runner.ts`
passes it with `-e`, and `job.sh` requires it.

The fix is the sentence, with an alias:

- `job.sh` exports `EUMAEUS_JOB_ID`, `EUMAEUS_REPO`, and `EUMAEUS_BRANCH` before any runner starts, `shell`
  included.
- The hand-off text gains one sentence: "This is eumaeus job `<id>`; `$EUMAEUS_JOB_ID`, `$EUMAEUS_REPO`, and
  `$EUMAEUS_BRANCH` hold the id, the repo, and the branch."

## The whole last message is kept, and `job_status` returns it

A continuation's report carries body edits and a "Left for the next job" list, and runs past 4,000 characters. The
log keeps 2,000 (`head -c 2000`), `AGENT_SUMMARY` keeps 4,000, and the transcript's `result` line is cut at 4,000 by
`job_transcript`. No path returns the whole thing.

`job.sh` writes the runner's final message, whole, to `$OUT/report.md`: `.result` for claude, `codex-last.md` for
codex, `.response` for antigravity, and `runner.txt` for pi. The log line stays cut at 2,000 characters.

`job_status` gains a top-level `report`, read from `out/<id>/report.md` when the tool is called, with no cut.
`list_jobs` leaves it out. It is not `result.summary`: `result` is the JSON line `job.sh` printed, stored in the
row, and a 6,000-character string there would ride along in every `list_jobs` response.

## A later job can replace the PR body

`job.sh` writes `/work/pr.md` into the PR only when it opens the PR. On an open PR it leaves the body alone, with the
comment "The body belongs to whoever opened the PR". A `no_changes` job exits at `emit no_changes` before the PR
code runs at all. So the 2nd, 3rd, and 4th job on a row can't touch the body, and a restack job, which pushes with
`--force-with-lease` itself, never reaches the PR code: after its own push, `origin/<branch>` equals `HEAD`,
`rev-list --count` is 0, and the job ends `no_changes`.

**`pr_body: "replace"`:** a `submit_job` parameter, stored in a `pr_body` column and passed to the VM as `PR_BODY`.
When it is set, the job wrote `/work/pr.md`, and a PR is open on the branch, `job.sh` runs `gh pr edit` with:

- the title from line 1 of `pr.md`, cut at 72 characters as today;
- the body from the rest, then this job's screenshots if it saved any, then this job's `eumaeus run` block, then
  `PR_FOOTER`.

The previous job's run block goes with the old body. The PR code moves above the `no_changes` exit, so a
`no_changes` job with the flag edits the body too; without the flag it ends as today. Screenshots are still saved
only after a push by `job.sh`. On a `pushed` job with the flag, they go in the body rather than a comment.

The result gains `pr_edited: true`, and a `no_changes` job's result gains `pr_url` when a PR is open. With the flag
set and no `pr.md`, the log says `pr_body=replace but no /work/pr.md; body unchanged` and `pr_edited` is `false`.

## The job's own CI result becomes a commit status

With Actions off, the PR page shows no check, and `src/ci.ts` settles `none` 5 minutes after every push. The agent
ran `mise run ci` and wrote the result into the body, and 8 PRs were merged on that line.

**`/work/ci.json`:** a file the agent writes: `{"state": "success", "description": "7/7 steps, 1,077 vitest and
783 cargo tests"}`. `state` is `success` or `failure`. `sha` is optional. After the push, or once a `no_changes`
job's head is known, `job.sh` posts a commit status with context `eumaeus/ci` on `HEAD`, the description cut at 140
characters, GitHub's limit, and `target_url` set to the PR when there is one.

The status goes on `HEAD`, not on the `sha` the agent wrote. `job.sh` commits whatever the agent left uncommitted
after the agent exits, so the agent's `sha` can name a commit that was never pushed. When `sha` is present and
differs from `HEAD`, the description starts with `agent tested <short sha>; ` so the PR page says so. The result
gains `ci_reported: {state, sha, description}`, or `ci_reported: {error}` when the state is invalid or the post
fails; the push stands either way.

`src/ci.ts` needs no change to read it: `/commits/<sha>/status` already lists commit statuses, and the watcher
settles `success` or `failure` once it sees the same finished set twice, 30 to 60 s after the push, instead of
`none` after 5 minutes. Two consequences:

- `failure` is in the watcher's fixable set, so a job with `ci_fix` above 0 that reports a failure gets a fix job
  whose failure text is the description. The client passes 0.
- The watcher watches `pushed` jobs only. A `no_changes` job's status shows on GitHub and in a still-pending watch
  on the same commit, and nowhere else.

The hand-off text gains one sentence: "To report the CI you ran, write `/work/ci.json` as `{"state": "success" or
"failure", "description": "<what ran, 140 characters at most>"}`; the harness posts it as the commit status
`eumaeus/ci` on the commit it pushes."

The GitHub App needs `statuses: write`. `scripts/github-app-setup.ts` asks for it on a new app. On an existing app:
Permissions & events, Commit statuses, Read and write, save, then accept on the installation. Without it the post
gets a 403, which lands in `ci_reported.error`.

The README's limits gain: `eumaeus/ci` repeats what the agent wrote to `/work/ci.json`. It is not an independent run,
and a branch rule that requires it is satisfied by the agent's own claim.

## `after`: a chain runs in order and stops at its first break

The queue runs in created order, and M7 step 2 holds a job while another runs on its branch. Nothing orders jobs on
different branches. A stacked build on row 12 must wait for row 13's fix job, on another branch, so the client
writes a git-ancestry check into every stacked brief, and on 2026-10-19 that check killed 6 jobs. With
`EUMAEUS_MAX_CONCURRENT` above 1, created order stops meaning anything.

**`after`:** a `submit_job` parameter, one job id or a list, stored as a JSON array in an `after` column, with
**`after_status`**, the statuses that let this job start, default `["pushed", "no_changes"]`. Any job id works,
on any repo or branch, up to 20. An id with no row is refused at submit: `after: no job <id>`, and nothing is
queued.

**Chain:** jobs linked by `after`. Three rules:

1. `claimNext` skips a queued job while any job it names is `queued` or `running`. The branch rule still applies.
   In SQL, `json_each(q.after)` joined to `jobs`.
2. When a job ends outside a waiter's `after_status`, the waiter ends `cancelled` with the error
   `after <id> ended <status>`, and no VM boots. That cancellation cascades to the waiter's own waiters, so the
   chain stops at the first break.
3. The cascade runs on every terminal write. Today `db.finish` is called from five places: the launch's finish, the
   timeout, `cancel`, `recover` after a restart, and `shutdown`. One `Scheduler` method wraps them all. Submit runs
   the same check against named jobs that are already terminal, so a job chained behind one that failed an hour ago
   ends `cancelled` at once.

A `skip_if` job ends `no_changes`, which is in the default, so a skipped continuation lets the review run.
`cancel_job` on a chain's head cancels the rest. To run a job after a failure, pass
`after_status: ["pushed", "no_changes", "failed"]`. `job_status` shows `after` and `after_status`.

## `skip_if`: a check decides whether the agent runs

Nobody is awake to decide whether a continuation or a fix is needed, so the loop queues both behind every build. On
2026-10-20, 5 of 7 continuations and row 14's continuation and fix each booted a VM, ran setup, and started an agent
to find nothing to do.

**`skip_if`:** a `submit_job` parameter, a bash command, stored in a `skip_if` column and passed as `SKIP_IF`.
`job.sh` runs it in `/work/repo` after the checkout and before the environment setup, with `GH_TOKEN` and the
`EUMAEUS_*` variables set, under `timeout 120`. Exit 0 ends the job `no_changes` with `skipped: <first line of its
output, 200 characters>` in the result. Any other exit, the timeout's 124 included, runs the job as usual, and the
log records the exit code and the first line.

It runs before setup, not after, because `gh`, `git`, `jq`, and `node` are in the image and the client's checks are
`gh pr view` calls: one for a "Left for the next job" list in the body, one for a `Review:` comment that says
`0 blocking`. Setup took 7 s to 223 s on the 2026-10-20 jobs. A check that needs the repo's tools doesn't fit; none
of the client's do. A skipped job's disk is not promoted, since setup didn't run.

What a skipped job still costs: the VM boot and the clone. Step 7 measures it.

## Peak memory per job

The client's heaviest step is `mise run ci`: a Rust build with `CARGO_BUILD_JOBS=2`, Postgres, Vitest, and Storybook
tests in Chromium. The README's one measurement is 937 MB for one Chromium page in a 4 GB VM. Nothing measures a
whole job.

`job.sh` starts a sampler as its first act: every 2 s it reads `/proc/meminfo`, computes `MemTotal` minus
`MemAvailable`, and keeps the largest value in `/work/peak_mem`. `emit` stops the sampler and adds `peak_mem_mb` and
`mem_total_mb` to every result line, the failed ones included. `mem_total_mb` is what the kernel saw, a little under
the `--memory` limit; the limit itself is the row's `memory` column, which `list_jobs` already shows. The log ends
with `memory: peak <n> MB of <m> MB`.

A 2 s sample misses a spike shorter than that. When the kernel kills the agent's command for memory, the last
sample before the kill is the peak, and the job fails with the runner's exit code.

## A memory budget instead of a job count

`pump()` starts jobs while the active count is under `EUMAEUS_MAX_CONCURRENT`, and it ignores each job's memory.
On the 16 GB mini two 8G jobs can't run together, but two 5G jobs might, and today the count is the only knob.

**`EUMAEUS_MEMORY_BUDGET`:** for example `12G`, same syntax as `memory`. Empty, the default, turns it off.

- A job starts when the memory limits of the running jobs plus its own fit under the budget.
  `EUMAEUS_MAX_CONCURRENT` stays as a ceiling. `/healthz` shows `memory: {budget_mb, in_use_mb}`.
- `claimNext` becomes `ready()`, the queued jobs that pass the branch and `after` rules in created order, and
  `claim(id)`. `pump()` starts the first ready job that fits, then looks again. A job that doesn't fit doesn't hold
  the ones behind it: a 4G review starts beside an 8G build while a second 8G build waits. The cost is that an 8G job
  can wait while 4G jobs keep arriving and fitting; on the client's queue every job that must wait says so with
  `after`.
- `submit_job` with `memory` over the budget returns `memory 16G is over EUMAEUS_MEMORY_BUDGET 12G` and queues
  nothing. The CI watcher and the inbox reuse a parent job's memory, which already passed. `EUMAEUS_MEMORY` over the
  budget stops the dispatcher at start with both numbers.

The budget counts limits, not peaks: two 8G jobs that peak at 3 GB each still count 16G, because a VM's peak is
known only when it ends and the limit is what `container` may hand it. Step 5's measurements set the limits the
client passes; the budget then keeps the sum honest.

This step is built last, after step 5, and only if the numbers justify it. If `mise run ci` needs 8G, a 12G budget
on 16 GB runs the client's jobs one at a time, which `EUMAEUS_MAX_CONCURRENT=1` does today, and the step is recorded
as skipped in Results.

## What this costs

- The app's Commit statuses permission grows to write. The bot can set any status on any installed repo, and a
  branch rule that requires `eumaeus/ci` is met by the agent's own claim.
- `skip_if` runs client bash in the VM with the repo token. The task already does, so the trust is unchanged.
- The PR section of `job.sh` moves above the `no_changes` exit and gains an edit path.
- One `json_each` join per claim, one `gh api` call per `ci.json`, and a shell loop reading one file every 2 s.
- One more file per job in the out dir, the size of the agent's last message.
- Four new columns (`pr_body`, `after`, `after_status`, `skip_if`), added on open like `parent_id` and `pr_footer`.
- A job waiting on `after` holds nothing: no VM, no slot.

## Edge cases

- `after` names a job on another repo. Allowed; ids are global.
- `after` names a job that doesn't exist yet. Impossible: ids are refused unless the row exists, so a chain can't
  form a cycle.
- The dispatcher crashes mid-chain. `recover` marks the running job `failed`, and the cascade cancels its waiters.
  `scripts/update.sh` drains running jobs first, so an update breaks no chain.
- `cancel_job` on a queued job in a chain. Its waiters cancel too, with its id in their error.
- `skip_if` exits 0 and `pr_body: "replace"` is set. Nothing to replace; `pr_edited` is `false`.
- `skip_if` hangs. `timeout 120` ends it with 124, and the agent runs; the log says so.
- `ci.json` has a state other than `success` or `failure`. Nothing is posted; `ci_reported.error` says why.
- A `shell` job writes `ci.json`. Posted the same way.
- The status post gets 403. The push stands; `ci_reported.error` carries the message.
- `pr_body: "replace"` on a `no_changes` job with no open PR. Nothing happens. On a `pushed` job, a PR is opened as
  today.
- `pr.md`'s first line is over 72 characters. Cut, as today.
- A `memory` exactly equal to the budget. Starts when nothing runs.
- A chain's head is skipped by `skip_if`. It ends `no_changes`, and the chain continues.

## Steps

Each step is one commit, checked before the next starts, with `pnpm typecheck` before each. Each step also updates
its README lines, its `submit_job` or `job_status` description in `src/mcp.ts`, and the server instructions where
behavior changed. Checks run on [`clayharmon/eumaeus-fixtures`](https://github.com/clayharmon/eumaeus-fixtures)
unless they name hermesmoney. The order is the client's, by value, with the budget last because it needs step 5's
numbers.

1. **`pr_body: "replace"`.** The column, `PR_BODY`, and the PR section moved above the `no_changes` exit. Check: a
   `shell` job on an open PR writes `/work/pr.md` and a commit, with the flag; the title and body change and the
   body ends with the job's run block. A second `shell` job writes `pr.md` and no commit, with the flag; it ends
   `no_changes` with `pr_edited: true` and the body changes again. The same two jobs without the flag leave the
   body as it was.
2. **The job id in the environment.** The three exports and the hand-off sentence. Check: a `claude` job asked to
   print the three variables prints them, and `EUMAEUS_JOB_ID` equals the job's id. A `shell` job prints
   `$EUMAEUS_JOB_ID` to the log.
3. **`after`.** The columns, the submit check, `claimNext`'s skip, the cascade behind one `Scheduler` method.
   Check: `shell` jobs A (`exit 1`), B after A, and C after B. B and C end `cancelled` with `after <id> ended
   failed`, and their logs have no dispatcher start line. A passing chain on two branches with
   `EUMAEUS_MAX_CONCURRENT=2` starts in order; the log timestamps show each start after the previous end. A job
   after an unknown id is refused. `cancel_job` on a queued head cancels its chain. B with
   `after_status: ["failed"]` runs after A fails.
4. **`eumaeus/ci` commit status.** `ci.json`, the post, the hand-off sentence, `statuses: write` in
   `github-app-setup.ts`, the permission accepted on the installation by hand, the README limit. Check: a `shell`
   job writes `success` and the PR shows a green `eumaeus/ci`, and `job_status` shows `ci.status: success` within
   60 s. Another writes `failure` and shows red. A `no_changes` job posts on the branch head. A job whose `sha` is
   not `HEAD` gets the `agent tested` prefix.
5. **Peak memory.** The sampler, `peak_mem_mb` and `mem_total_mb` in `emit`, the log line. Check: a `shell` job
   running `node -e 'Buffer.alloc(1<<30, 1); setTimeout(() => {}, 8000)'` reports a peak above 1,000 MB. Then
   hermesmoney's `CARGO_BUILD_JOBS=2 mise run ci` as a `shell` job at 8G, 6G, and 4G, `cpus: 8`, with the peak,
   pass or fail, and duration of each recorded in Results. That answers the client's memory question.
6. **The whole report.** `report.md` in the out dir and `report` in `job_status`. Check: a `claude` job asked to
   end with a numbered list of 6,000 or more characters; `report`'s length equals the length of `.result` in the
   transcript, and the log line is still 2,000 characters.
7. **`skip_if`.** The column, `SKIP_IF`, the run before setup, `skipped` in the result. Check: `skip_if: "true"` on
   a `claude` job ends `no_changes` with no `[agent]` line and no `usage`, and the log shows the time from VM start
   to end. `skip_if: "false"` runs the agent. A `gh pr view` check against a fixtures PR skips when the body has the
   marker and runs when it doesn't. A job `after` a skipped job runs.
8. **Memory budget.** `EUMAEUS_MEMORY_BUDGET`, `ready()` and `claim()`, the submit check, `/healthz`. Built only if
   step 5 shows a limit under 8G passes. Check: with a 12G budget, two 8G jobs run one after the other, two 4G jobs
   run together, a 16G submit is refused with both numbers, and `/healthz` shows `in_use_mb` while they run.

## Done when

- On the fixtures repo, a chain shaped like one row of the wave: a `shell` build that pushes; a continuation with
  `skip_if: "true"` after it; a review that posts a `Review: 0 blocking` comment after that; a fix whose `skip_if`
  reads the comment, after the review. The continuation and fix end `no_changes` with `skipped`, nothing in the
  chain needed a hand edit, and `job_status` on every job shows `peak_mem_mb` and `report`.
- A restack-shaped job force-pushes the branch itself and replaces the body with `pr_body: "replace"`.
- The PR shows a green `eumaeus/ci` from a job that wrote `ci.json`.
- A failed chain head cancels the jobs behind it, and none of them booted a VM.
- The client's memory question has three numbers in Results.
- `pnpm smoke <owner/repo>` passes.

## Not in M8

- A skip check on the host, before a VM boots. It would run client bash on the mini.
- An independent CI run. `eumaeus/ci` is the agent's claim.
- Scheduling by measured peaks, or by CPU.
- Priorities. The queue stays created order, with jobs that fit starting ahead of one that doesn't.
- Editing part of a PR body between markers. `replace` is whole or nothing.
- Memory samples finer than 2 s.
- Screenshots on a `no_changes` job.
- `after` conditions other than status, such as a CI result.
- Any change to what the runners do, to `ci_fix`, or to the inbox.

## Results

### Step 1: `pr_body: "replace"`

| Check | Result |
|---|---|
| A `shell` job on an open PR writes `/work/pr.md` and a commit, with the flag; the title and body change and the body ends with the run block | job `20261020-132636-805a` on PR #18, opened by hand: `pushed`, `pr_edited: true`, 11.5 s. The title became `M8 step 1: replaced by job one`, and the body was the file's text, then the `eumaeus run` block naming `805a` |
| A second `shell` job writes `pr.md` and no commit, with the flag; it ends `no_changes` with `pr_edited: true` and the body changes again | job `20261020-132706-2ed4`: `no_changes`, `pr_edited: true`, `pr_url` set, 6.3 s. The title became `M8 step 1: replaced by job two, no commit`, and the run block named `2ed4` |
| The same two jobs without the flag leave the body as it was | jobs `20261020-133217-03f3` (`pushed`, 6.7 s) and `20261020-133217-a5e5` (`no_changes`, 9.0 s) each wrote a `pr.md` saying "Must not appear". After both, the title and body were job `2ed4`'s, unchanged, and neither result has `pr_edited` |
| The flag with no `pr.md`, from the edge cases | job `20261020-133249-b951`: `no_changes`, `pr_edited: false`, and the log line `pr_body=replace but no /work/pr.md; body unchanged` |

What the build changed from the plan:

- Only an open PR counts as already open. `gh pr view <branch>` also returns a closed or merged one: from the
  laptop, `gh pr view m7-serial` returned PR #3, `CLOSED`. Before this step a job pushing to such a branch logged
  `pr already open` and opened nothing; now it opens a new PR. The replace path uses the same filter, so a merged
  PR's body is never rewritten.
- Every `no_changes` job's result carries `pr_url` when a PR is open on its branch, flag or not, and `job_status`
  shows it as `url`. Finding the PR is one `gh pr view` call, and the flag's path needs it anyway.
- `pr_edited` is in the result only when the flag is set, as `true` or `false`.
- A `no_changes` job never adds the assignee; only a push does, as before.
- The hand-off sentence changes with the flag: the harness "opens the pull request from that file, or, when one is
  already open, replaces its title and body with that file."
- One function, `pr_text`, builds the title and body for both the open and the replace paths, so a `pr.md` with a
  title and no body gets the fallback body in both.
- PR #18 stays open for later steps.

### Step 2: the job id in the environment

| Check | Result |
|---|---|
| A `claude` job asked to print the three variables prints them, and `EUMAEUS_JOB_ID` equals the job's id | job `20261020-133614-02c5`, Haiku 5.5, 2 turns, $0.002, 11.3 s from VM start to exit. Its one command was `printf '%s=%s\n' EUMAEUS_JOB_ID "$EUMAEUS_JOB_ID" ...`, and its final message was the three lines `EUMAEUS_JOB_ID=20261020-133614-02c5`, `EUMAEUS_REPO=clayharmon/eumaeus-fixtures`, and `EUMAEUS_BRANCH=job/20261020-133614-02c5` |
| A `shell` job prints `$EUMAEUS_JOB_ID` to the log | job `20261020-133614-eb24`, 4.5 s: the log has `shell sees EUMAEUS_JOB_ID=20261020-133614-eb24 EUMAEUS_REPO=clayharmon/eumaeus-fixtures EUMAEUS_BRANCH=job/20261020-133614-eb24` |

What the build changed from the plan:

- The export sits before the clone, so a repo's setup command sees the three variables too.
- The job line is the hand-off's first sentence, before the browser and the PR file.
- `submit_job`'s description and the README's Runners section name the three variables, so a client's brief can
  say "name the job" instead of pasting the id.

### Step 3: `after`

| Check | Result |
|---|---|
| `shell` jobs A (`exit 1`), B after A, C after B: B and C end `cancelled`, and their logs have no dispatcher start line | A `20261020-134837-46ac` failed `runner_exit_1` at 13:48:43.130. In the same millisecond B `20261020-134837-8d5e` ended `cancelled` with `after 20261020-134837-46ac ended failed`, and C `20261020-134837-eca2` with `after 20261020-134837-8d5e ended cancelled`. Each log is one line: `cancelled: after <id> ended <status>; no VM started` |
| A passing chain on two branches with `EUMAEUS_MAX_CONCURRENT=2` starts in order | D `20261020-134852-a729` on `m8-chain-x`, E `a010` on `m8-chain-y` after D, F `f8da` on `m8-chain-x` after E, each `sleep 3`. D ran 13:48:52.401 to 13:49:04.867; E started 13:49:05.467, 0.6 s after D's exit, and ran to 13:49:17.513; F started 13:49:18.182, 0.7 s after E's exit. While D ran, `/healthz` showed `running: 1, queued: 2`: a slot was free and E stayed queued |
| A job after an unknown id is refused | `after: no job 20250101-000000-dead`, alone and paired with A's id; `list_jobs` shows no row for either |
| `cancel_job` on a queued head cancels its chain | with the pause file in place, G `20261020-134934-1c16`, H `64fa` after G, I `949f` after H. Cancelling G ended H with `after 20261020-134934-1c16 ended cancelled` and I with `after 20261020-134934-64fa ended cancelled`, both at 13:49:34.826 |
| B with `after_status: ["failed"]` runs after A fails | `20261020-134846-6af9`, submitted 3 s after A failed, started at once and logged `ran after failure`, `no_changes` |
| A job submitted behind A with the default `after_status` | `20261020-134847-07c8` came back from `submit_job` already `cancelled`, `after 20261020-134837-46ac ended failed` |

What the build changed from the plan:

- A cancelled waiter's log gets one line, `cancelled: after <id> ended <status>; no VM started`, so `job_logs`
  doesn't answer `(no log yet)` for a job that ended.
- Each link names its own dependency: C's error says B ended `cancelled`, not that A failed. The chain's head is
  one `job_status` away.
- `recover` checks every queued waiter against its named jobs after marking orphans failed, for a crash between a
  job's end and the cascade.
- `cancel_job` on a queued job pumps, for a waiter whose `after_status` includes `cancelled`.
- `after_status` accepts terminal statuses only, and `after` takes 20 ids at most.
- `submit_job` returns the row after the check, so a job cancelled at submit reads `cancelled` in the reply.
- The README gains a "Chains" section.

### Step 4: `eumaeus/ci` commit status

All on PR #18 of the fixtures repo, branch `m8-pr-body`, as `shell` jobs that write `/work/ci.json`.

| Check | Result |
|---|---|
| A job writes `success`; the PR shows a green `eumaeus/ci`, and `job_status` shows `ci.status: success` within 60 s | job `20261020-140640-096a` pushed `4b2d402e` and posted `eumaeus/ci` `success` with the description `7/7 steps, 1,077 vitest and 783 cargo tests` and the PR as `target_url`, 10.2 s from VM start to exit. The watcher settled `ci.status: success` 47 s after the job finished |
| Another writes `failure` and shows red | job `20261020-140742-a67f` pushed `baf6dfad` and posted `failure`, `step 5 of 7 failed: 2 vitest tests`. GitHub's combined state for the commit was `failure`. The watcher settled `failure` 48 s later with the note `shell jobs are watched, not fixed` |
| A `no_changes` job posts on the branch head | job `20261020-140844-12cf`, no commit, posted `success` on `baf6dfad`, the branch head, which `ci_reported.sha` names. The commit's combined state went from `failure` to `success` |
| A job whose `sha` is not `HEAD` gets the `agent tested` prefix | job `20261020-140855-c74d` wrote `sha: baf6dfad` and a commit; `job.sh` committed `718fcc5d` and posted on it with the description `agent tested baf6dfa; tested before the harness commit` |
| Without the permission, from the edge cases | before the change, job `20261020-140238-d2b6` pushed `d92483c2` and its result had `ci_reported: {error: "gh: Resource not accessible by integration (HTTP 403)"}` |

The permission change was made by hand on `you-eumaeus`: Commit statuses to Read and write, accepted on the
installation. The next job's token had it.

What the build changed from the plan:

- A `no_changes` job on a branch that was never pushed sits on the base's commit, so nothing is posted and
  `ci_reported.error` says `nothing pushed: HEAD is the base branch's commit`. Otherwise a status meant for the branch
  would land on `main`.
- `ci.json` with no `description` posts `reported by eumaeus job <id>`.
- `sha` may be short: it matches `HEAD` as a prefix.
- The description is cut at 140 characters by jq, which counts characters rather than bytes.
- `ci_reported.sha` is the commit the status went on, `HEAD`, not the agent's `sha`.
- README's CI section describes `ci.json`, and the permission paragraph now asks for Commit statuses write.

### Step 5: peak memory

| Check | Result |
|---|---|
| A `shell` job running `node -e 'Buffer.alloc(1<<30, 1); setTimeout(() => {}, 8000)'` reports a peak above 1,000 MB | job `20261020-141158-f310`: `peak_mem_mb: 1208`, `mem_total_mb: 4047`, in a `4G` VM. The log ends `memory: peak 1208 MB of 4047 MB` |
| An idle `shell` job, for the floor | job `20261020-141158-6075`, `true`: `peak_mem_mb: 147`. That is the VM, the clone, and `gh`, before any agent |
| hermesmoney's `CARGO_BUILD_JOBS=2 mise run ci` as a `shell` job at 8G, 6G, and 4G, `cpus: 8` | pending: it runs on the mini, which holds the repo's warm disk, after this step is deployed there |

What the build changed from the plan:

- The sampler starts before the root check, so a job that fails at once still reports a peak.
- `mem_total_mb` for a `4G` VM is 4,047 MB: what the kernel sees after its own reservations.
- The sampler is a bash loop around `awk` on `/proc/meminfo`; it writes the file only when the peak grows.

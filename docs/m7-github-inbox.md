# M7: work from the pull request

Status: built; [Results](#results) records what changed from the plan. Browser measurements are from a spike on an
Apple silicon Mac on `container` 1.5.0 with `@playwright/cli` 0.1.22.

## You review on GitHub, and eumaeus can't hear you there

A job opens PR #12 and assigns it to you. You read it on your phone and leave two inline comments in a review.
Nothing happens. eumaeus takes work from one place, the MCP tool `submit_job`, so the comments wait until you are
back at a terminal and paste them into a task with `branch=` set to the PR head.

Starting work has the same gap. A bug filed as an issue becomes a job only when someone copies it into `submit_job`.

The PR also can't show you what changed on screen. Take a job asked to fix a button that overflows on narrow screens.
The agent edits the CSS, the tests pass, and the PR carries a diff. The VM has no browser, so neither the agent nor
you has seen the page.

## The CI watcher already turns one GitHub event into a job

`src/ci.ts` polls GitHub every 30 s for the checks on each pushed commit. When one fails, it submits a follow-up job
on the same branch with the failure as the task. Nobody calls `submit_job`.

An issue label and a comment are events of the same kind. Each names a branch, or a base for a new one, and carries
the text of a task. The CI watcher has no rule for whose events count, and doesn't need one: a check result comes
from the repo's own CI. A comment on a public repo can come from anyone with a GitHub account.

## Requirements

- Only GitHub users you name can start a job.
- No inbound port. The dispatcher listens on `127.0.0.1` or on the tailnet through `tailscale serve`, which GitHub
  can't reach.
- Each event starts at most one job, across dispatcher restarts.
- Turning the inbox on doesn't act on events from before it was on.
- Two jobs never push to one branch at the same time.
- The whole loop works from GitHub Mobile: start a job, ask for changes, see the result.
- The browser is a shell command, so every runner can use it, not only runners with an MCP client.

## A trigger is a GitHub event caused by someone you named

**Trigger:** a GitHub event the dispatcher turns into exactly one job. A failed check is the one trigger eumaeus has
today. M7 adds two:

| Trigger | Where | Job |
|---|---|---|
| The label `eumaeus` is added | an open issue | a new branch from the repo's default branch; the task is the issue; the PR closes it |
| A mention of the app, `@you-eumaeus` | a new issue, a comment on an open issue, a PR comment, an inline review comment, or a review's body | on an issue, as the label, with the mentioning text added; on a PR, on its head, with the mentioning text as the task |

**Mention:** `@<app slug>`, the slug read from `~/.config/eumaeus/github-app.json`. This install's app is
`you-eumaeus`, so its bot is `you-eumaeus[bot]`. A mention counts outside quoted lines (`>`) and code, matched
without regard to case, and not followed by a letter, digit, or hyphen. No GitHub user holds the login `you-eumaeus`
(checked 2026-10-19), so the mention notifies nobody.

**Allowed user:** a GitHub login listed in `EUMAEUS_INBOX_USERS`, comma-separated. A trigger counts only when an
allowed user caused it: added the label, or wrote the text with the mention. The variable is empty by default, and
empty turns the inbox off.

**Inbox:** the dispatcher loop that finds triggers, records them, and submits their jobs. It lives in `src/inbox.ts`,
next to `src/ci.ts`.

The person who causes a trigger vouches for the text it carries. Labeling an issue someone else wrote tells an agent
to follow that issue's body. A task includes the issue body and comments by allowed users, and leaves out comments by
anyone else.

## Polling, because GitHub can't reach the dispatcher

GitHub's REST guidance prefers webhooks to polling. A webhook needs a URL GitHub can reach. `tailscale funnel` would
make one, and the dispatcher would then take requests from the whole internet. The inbox polls, as the CI watcher
does.

Every `EUMAEUS_INBOX_POLL_S` seconds (default 60), for each repo the GitHub App is installed on:

| Call | What it finds |
|---|---|
| `GET /repos/{repo}/issues/events` | `labeled` events, with the label and who added it |
| `GET /repos/{repo}/issues/comments?since=<cursor>` | new comments on issues and PRs |
| `GET /repos/{repo}/pulls/comments?since=<cursor>` | new inline review comments |
| `GET /repos/{repo}/issues?since=<cursor>` | new issues, for a mention in the body |
| `GET /repos/{repo}/pulls/{n}/reviews`, once per PR updated since the cursor | review bodies, with their author |

The repo list comes from `GET /installation/repositories` every 10 minutes. These calls use installation-wide tokens
that stay in the dispatcher. A VM still gets a token for its one repo.

Each request sends the previous response's ETag in `If-None-Match`. GitHub's docs say a `304` to an authorized
conditional request doesn't count against the rate limit, and most polls find nothing new. With 10 repos, the worst
case, with no `304`s at all, is 2,400 requests an hour, plus one per PR updated since the last poll. An installation's
limit is at least 5,000, shared with the CI watcher.

## Each trigger starts one job, even across restarts

A poll can see an event a second time, and the dispatcher can stop between seeing an event and submitting its job.
A new SQLite table, `triggers`, holds one row per trigger. Its primary key is GitHub's id for the event:
`label:<event id>`, `issue:<issue id>`, `comment:<comment id>`, `review-comment:<comment id>`, or
`review:<review id>`. The inbox inserts that row and the job's row in one transaction, so a crash leaves both or
neither. A poll that sees the event again hits the primary key and moves on.

A second table, `inbox_cursors`, keeps per repo the time of the last poll that succeeded. The inbox reads only events
created after the cursor. A repo seen for the first time gets a cursor of now, so turning the inbox on, or installing
the app on another repo, ignores what came before. After a restart the inbox resumes from the stored cursor and finds
what happened while it was down.

## Two triggers, and the task each one writes

### Issue: the label or a mention

```
Resolve issue https://github.com/<repo>/issues/<n>: <title>

<body>

Comments from allowed users:
- @<login>: <comment>
```

The job branches from the repo's default branch, read from `GET /repos/{repo}`. The dispatcher passes
`PR_FOOTER=Closes #<n>`, and `job.sh` appends it to the PR body, whether the agent wrote the body or not. The inbox
removes the label when it submits the job, so adding the label again starts another job. That is how you retry.

A mention in the issue body, or in a comment on the issue, starts the same job. The task already holds the body and
the allowed users' comments, so the mentioning comment is in it.

### PR: a mention

The job runs on the PR head. Its task depends on where the mention is:

- A PR comment: the comment's text.
- An inline review comment: the comment's text, with its file, line, and the last 5 lines of its diff hunk.
- A review's body: the body's text, followed by every inline comment of that review. One review is one job, even when
  its inline comments also mention the app.

```
@<login> asked on pull request <url> at commit <sha>. You are on that branch. Do what they ask, run the checks the
change touches, and commit.

<review body>

- src/app.ts:42: <comment>
- src/app.ts:87: <comment>

The task that produced this branch:
<parent task>
```

When an eumaeus job pushed the PR head, the new job takes that job's runner and model, sets `parent_id` to it, and
appends its task, the way `CiWatcher.submitFix` does. On a PR a person opened, the job runs `claude` with its default
model. Either way the head has to be a branch in the same repo.

## One job per branch at a time

Today two jobs can run on one branch at once, for example a CI fix and a job you submitted with `branch=`. The second
`git push` is rejected as a non-fast-forward, and that job fails. With triggers this gets common: you mention the app
on a PR while a CI fix is running.

`Db.claimNext` skips a queued job when a running job has the same repo and branch. The skipped job starts when the
running one finishes, on the branch's new head. Queued jobs on other branches go ahead of it.

The CI watcher also reads the branch head before it submits a fix. When the head has moved past the failing commit,
it records the failure with the note `superseded by <sha>` and submits nothing.

## The answer goes back to GitHub as reactions and one line

You started the job from GitHub, so the dispatcher answers there as the app's bot:

1. When it submits the job, it adds 👀 (`eyes`) to what triggered it: the issue, the comment, or the inline comment.
   GitHub's reactions cover issues, comments, and inline review comments, and not reviews, so a review's 👀 goes on
   its PR.
2. When the job ends, it deletes the 👀 and adds 🚀 (`rocket`) for `pushed` or `no_changes`, or 😕 (`confused`) for
   `failed` or `cancelled`.
3. Then it posts one line. An inline review comment gets the line as a reply in its thread; anything else gets it as a
   comment on the issue or PR.

| Outcome | Line |
|---|---|
| A new PR | `Opened #14.` |
| Commits on an existing PR | `Pushed 2 commits, up to 1a2b3c4.` |
| No changes | `No changes. Job 20261019-141500-ab12.` |
| Failed | `Failed: runner_exit_1. Job 20261019-141500-ab12.` |

`triggers` keeps the 👀's reaction id, so the dispatcher can delete it, and `replied_at`, so a restart neither loses
nor repeats an answer. `job_status` gains `trigger`: the kind, the URL, and who caused it.

The app's Issues permission goes from read to read and write, for labels, reactions, and comments.
`scripts/github-app-setup.ts` asks for it on a new app. An existing app is changed on its settings page, and the
installation accepts the new permission, the same way as for the CI permissions.

## A browser the agent drives from the shell

Back to the button. The agent needs to load the page at a narrow width and look. It can't `apt-get` a browser: it runs
as uid 1000 with no sudo. A repo can add one today through `.eumaeus.toml` `image =`. Every web repo would then
carry the same Dockerfile and build it per repo.

Playwright MCP gives an agent a browser through MCP, which needs each runner's MCP config, and it returns the page's
accessibility tree into the agent's context on each step. `@playwright/cli` is Microsoft's shell command for the same
browser: `playwright-cli open <url>`, `snapshot`, `click <ref>`, `screenshot`. It writes snapshots to files, so the
agent reads only what it asks for. Any runner with a shell can call it, and a `shell` job can script it.

A spike image built `FROM eumaeus-job:dev` with `@playwright/cli` and Playwright's Chromium:

| Measure | Result |
|---|---|
| Image size, from `container image ls` | 496.5 MB before, 815.9 MB after |
| Browser files in `/opt/ms-playwright` | 401 MB |
| Build time for the added layer | 61 s |
| `playwright-cli open https://example.com`, first call in a fresh VM | 1.6 s |
| `snapshot` then `screenshot` | 0.5 s |
| Summed RSS of the Chromium processes, one page open | 945 MB |

What the spike changed:

- `playwright-cli` looks for Google Chrome by default and failed with "Chromium distribution 'chrome' is not found
  at /opt/google/chrome/chrome". `PLAYWRIGHT_MCP_BROWSER=chromium` points it at Playwright's Chromium.
- `playwright install chromium` also downloads a 274 MB headless shell that the CLI doesn't use. `--no-shell` skips
  it.
- Playwright installs browsers into `~/.cache/ms-playwright`. `job.sh` links `~/.cache` into the repo's disk and
  copies what is already there, so every disk would get a copy. `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` keeps
  them in the image.
- The CLI writes snapshots to `.playwright-cli/` in the working directory, which is the repo, and `job.sh`'s
  `git add -A` would commit them. With `PLAYWRIGHT_MCP_OUTPUT_DIR=/work/.playwright-cli`, the repo stayed clean.
- Chromium ran in a VM that lacks the namespaces Nix's build sandbox needs.

Every job gets the browser. The job image gains, as root, after the agent CLIs:

```dockerfile
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright PLAYWRIGHT_MCP_BROWSER=chromium \
    PLAYWRIGHT_MCP_OUTPUT_DIR=/work/.playwright-cli
RUN npm install -g @playwright/cli@0.1.22 && npm cache clean --force \
 && node /usr/local/lib/node_modules/@playwright/cli/node_modules/playwright/cli.js install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/*
```

The hand-off in `job.sh` gains: "A headless Chromium is available through `playwright-cli`; run
`playwright-cli --help`. If your change affects what a browser renders, start the app, check the page, and save up
to 6 screenshots to /work/screenshots/." The version is pinned, so `update.sh` rebuilds the same CLI until a commit
changes it.

## Screenshots ride on their own branch

A screenshot helps the reviewer only if it reaches the PR. GitHub's REST API has no endpoint for attaching an image
to a PR body or comment. A Markdown image link to a file in the repo renders in a PR on a public repo.

After the job's push, `job.sh` commits `/work/screenshots/*.png`, at most 6 files of 2 MB each, under `<job id>/` on
an orphan branch named `eumaeus-screenshots`, and pushes that branch. When another job pushed first, it fetches and
retries, 3 times. The PR body links each file as
`https://github.com/<repo>/blob/<sha>/<job id>/<name>.png?raw=true`. The PR's own branch never holds a screenshot, so
a squash merge carries none.

Whether that link renders in GitHub Mobile, and on a private repo, is checked in step 6. If it doesn't, the PR lists
the links without embedding the images.

## What this costs

- GitHub text becomes agent instructions, and `EUMAEUS_INBOX_USERS` is the only gate. An issue body written by a
  stranger becomes a task once an allowed user labels it. The VM's token can push to any branch of its repo for an
  hour, the default branch included unless branch protection stops it. Protect the default branch on repos the
  inbox watches.
- The app's Issues permission grows to write. The dispatcher also mints installation-wide tokens on the host. They
  never reach a VM.
- If someone registers the GitHub login `you-eumaeus`, every mention notifies them.
- Every job boots an image 319 MB larger. Step 1 measures boot time on both images.
- One open page takes about 945 MB of the VM's 4 GB (`EUMAEUS_MEMORY`), before the app's dev server and the agent.
  A web repo with a heavy dev server may need `EUMAEUS_MEMORY=6G`.
- A branch named `eumaeus-screenshots` appears in each repo where a job saved a screenshot.
- Polling costs up to 2,400 GitHub requests an hour at 10 repos, plus one per PR updated since the last poll, minus
  every `304`.
- The inbox needs the GitHub App: the mention is the app's slug, and the answers come from its bot. With the `gh`
  fallback the inbox stays off and the dispatcher logs why.

## Edge cases

- A trigger arrives while a job runs on its branch. The new job queues and starts after, on the new head. Its task
  names the commit the mention was on, so the agent can check the comments still apply.
- A trigger from a login not in `EUMAEUS_INBOX_USERS` starts nothing. The dispatcher log records it.
- The label `eumaeus` is added to a PR. GitHub's events API treats PRs as issues. The inbox removes the label and
  replies that a mention is the way to ask for changes on a PR.
- A mention on a PR from a fork. The installation token can't push to the fork, so the inbox replies and starts
  nothing.
- A mention with no other text. On an issue it means "do this issue". In a review's body it means "address these
  inline comments". In a PR comment, or an inline comment alone, the inbox replies that it needs instructions and
  starts nothing.
- A reply that quotes an earlier mention. Quoted lines don't count, so it starts nothing.
- A comment edited to add a mention. Not a trigger: the inbox reads text created after its cursor.
- An issue or PR closed before the poll that would see its trigger. Skipped.
- Two dispatchers use the same GitHub App, for example one on a laptop and one on a server, each with its own
  database. With the inbox on in both, both submit a job for every trigger. Set `EUMAEUS_INBOX_USERS` on one.
- A `403` or `429` with `x-ratelimit-remaining: 0` pauses the inbox until `x-ratelimit-reset`.
- The label doesn't exist in a repo. Create `eumaeus` once per repo; the inbox never creates labels.

## Steps

Each step is one commit, checked before the next starts. [`clayharmon/eumaeus-fixtures`](https://github.com/clayharmon/eumaeus-fixtures)
gets a `web` branch: one HTML page with a button that overflows at 375 px, and a `package.json` whose `dev` script
serves it on port 3000.

1. **Browser in the image.** The Dockerfile layer and environment above, and the hand-off sentence in `job.sh`.
   Check: a `shell` job runs `playwright-cli open https://example.com && playwright-cli screenshot
   --filename=/work/s.png` and reaches `no_changes`. A `claude` job on `web` fixes the overflow, and its transcript
   shows `playwright-cli` at 375 px. Neither job commits `.playwright-cli/`. The log has the time from VM start to
   clone on the old and new image.
2. **One job per branch.** `claimNext` skips busy branches, and the CI watcher skips superseded failures. Check: two
   `shell` jobs submitted together on one branch both reach `pushed`, the second starting after the first finished.
3. **Inbox loop.** `EUMAEUS_INBOX_USERS` and `EUMAEUS_INBOX_POLL_S`, the `triggers` and `inbox_cursors` tables, the
   repo list, ETags, Issues write in `github-app-setup.ts`, and `inbox` in `/healthz`: repos watched, last poll, and
   triggers waiting for an answer. Check: `/healthz` lists the fixtures repo. An issue labeled before the inbox
   started starts nothing. Two polls in a row return `304` and leave `x-ratelimit-remaining` unchanged.
4. **Issue label, and the answer.** Check: labeling an issue on the fixtures repo starts one job. Its PR body ends
   with `Closes #<n>`, and the label is gone. The issue shows 👀 while the job runs, then 🚀 in its place, then the
   line `Opened #<pr>.` A job made to fail ends with 😕 and a `Failed:` line. Restarting the dispatcher during the
   job submits no second job and posts no second line. With your login removed from `EUMAEUS_INBOX_USERS`, the same
   label starts nothing. `job_status` shows `trigger`.
5. **Mentions.** Check: a review on the step 4 PR with 2 inline comments and `@you-eumaeus` in its body starts one
   job whose commit addresses both. An inline comment `@you-eumaeus rename foo to bar` gets a commit and a reply in
   its thread. A mention on a PR opened by hand pushes to its branch. A mention in an issue comment opens a PR. A
   mention on a PR from a fork, a quoted mention, and a review with no mention start nothing.
6. **Screenshots.** Check: the step 1 `web` job, run again, shows its screenshot in the PR on github.com and in
   GitHub Mobile, on the fixtures repo and on a private repo. Two jobs saving screenshots at once both land on
   `eumaeus-screenshots`.
7. **README.** A new section on starting jobs from GitHub. Limits updated for the inbox's trust rule, the Issues
   permission, and the browser's memory.

## Done when

- From GitHub Mobile, with no terminal: label an issue and get a PR, then submit a review with inline comments and
  `@you-eumaeus` in its body and get a commit that addresses them. Each time, 👀 turns into 🚀 and one line follows.
- The overflow fix on `web` comes back with a screenshot in the PR that shows the button inside the viewport.
- No trigger starts two jobs across a dispatcher restart.
- A trigger from a login not in `EUMAEUS_INBOX_USERS` starts nothing.
- `pnpm smoke <owner/repo>` passes with the inbox on.

## Not in M7

- Webhooks. A receiver behind `tailscale funnel` is the upgrade if 60 s is too slow.
- Starting a job from a review without a mention, such as every "Request changes" review.
- Choosing a runner or model from GitHub. Triggered jobs use the branch's last runner, or `claude`.
- Resolving review threads.
- Talking to a running job. A mention during a job queues the next one.
- Merging on approval. `merge_pr` stays the way to merge.
- Scheduled jobs.
- The inbox with the `gh` fallback identity.
- GitLab and Bitbucket.
- Video recording through `playwright-cli video-start`.

## Results

### Step 1: browser in the image

| Check | Result |
|---|---|
| `shell` job opens example.com and takes a screenshot | job `20261019-145933-1fb3`, `no_changes`; `open` 1.6 s, `screenshot` 0.25 s, a 69,657-byte PNG |
| `claude` job on `web` fixes the overflow | job `20261019-150234-e5a7`, Sonnet 5.5, 6 turns, $0.053; it ran `playwright-cli resize 375 700` and measured a scroll width of 375; PR #2, closed |
| Neither job commits `.playwright-cli/` | `git status --porcelain --ignored` printed nothing; PR #2 changed only `index.html` |
| VM start to the clone line, 3 runs each | 1.30, 1.32, 1.43 s on the image before (496.7 MB); 1.68, 1.44, 1.45 s after (817.3 MB). The first boot after a build took 2.71 s |

What the build changed from the plan:

- The image gains `procps`. Without `ps` and `pkill` the `web` agent couldn't stop the dev server it had started.
  The image is 817.8 MB with it, and one open page measured 937 MB of Chromium RSS.
- `job.sh` creates `/work/screenshots/` before an agent runner starts.
- `scripts/run-job.sh` passes `BASE_BRANCH`, so a hand-run job can start from a fixture branch.
- `build-image.sh` took 82 s, with every layer above the browser's cached.

### Step 2: one job per branch

| Check | Result |
|---|---|
| Two `shell` jobs submitted together on `m7-serial` both reach `pushed` | `20261019-150651-e1f8` ran 15:06:51.349 to 15:07:19.362; `20261019-150651-907b` started 1 ms later and checked out `0c59fe6`, the first job's push. Both on PR #3, closed |
| A queued job on another branch goes ahead | of 3 jobs submitted in order (`m7-serial`, `m7-serial`, `m7-other`), the `m7-other` job started at 15:08:00.148 and the second `m7-serial` job at 15:08:15.112, when the first finished |
| A CI failure on a moved head starts no fix | Haiku job `20261019-150850-1677` pushed `56044eb1` from `ci-check`; a hand push made `1929c29b`; the watcher recorded `failure` with `superseded by 1929c29b` and submitted nothing. PR #4, closed |

What the build changed from the plan:

- `claimNext` compares repos without regard to case, since GitHub doesn't.
- When the branch is gone by the time CI fails, the watcher records `branch <name> no longer exists` and submits
  nothing. A fix would have recreated the branch from the base, without the failing commit.

### Step 3: inbox loop

| Check | Result |
|---|---|
| `/healthz` lists the fixtures repo | `inbox.repos` held 50 repos, `clayharmon/eumaeus-fixtures` among them |
| An issue labeled before the inbox started starts nothing | #5, labeled at 15:32:47, 7 s before the start: no log line, no trigger, no job |
| A label after the start is seen | #6, labeled at 15:34:41, logged as `label:33659735107` at 15:34:58 |
| Two polls in a row return `304` and leave `x-ratelimit-remaining` unchanged | the polls at 15:34:00 and 15:34:17 were all `304`; remaining was 6362 of 6450 after each |

What the build changed from the plan:

- The app is installed on 50 repos, not 10. With 4 calls per repo per poll, the worst case at 60 s would be
  12,000 requests an hour, plus reviews, against a limit of 6,450. Each repo's open-issue list, newest update first, is now
  the only request in a quiet poll. Labels, comments, and reviews all change it, and only then does the poll read
  the other endpoints. It keeps reading them for 60 s after, since one endpoint can show an event before another.
  A quiet poll of 50 repos took 2.5 s and 50 requests, all `304`.
- GitHub's ETags differ per token: the same request with a second token got a `200` and a new ETag. The inbox
  keeps each installation token for 50 minutes, so a new token costs one `200` per repo.
- `since=` in a URL is the cursor's hour, not the cursor, so the URL and its ETag stay the same between polls.
  The cursor trails each poll by 60 s, and the `triggers` primary key drops what the overlap sees twice.
- An ETag is stored, and the cursor moved, only when every request in that repo's poll succeeded.
- Archived repos aren't polled.
- `/healthz` `inbox` has `users`, `poll_s`, `repos`, `last_poll` (time, seconds, and a count per HTTP status),
  `waiting`, `rate` per installation account, and `paused_until`. With the inbox off it is `{off: <reason>}`.

### Step 4: issue label, and the answer

| Check | Result |
|---|---|
| Labeling an issue starts one job | #8, labeled at 00:18:48, was seen at 00:18:57 and started job `20261020-001857-4697` on `main`. It ran 14 s, Sonnet 5.5, 2 turns, $0.029 |
| Its PR body ends with `Closes #<n>`, and the label is gone | PR #9's body ends with `Closes #8`, and GitHub lists #8 under its closing issues. #8 had no labels 9 s after the label went on |
| 👀 while the job runs, then 🚀 in its place, then `Opened #<pr>.` | 👀 at 00:18:57; at 00:19:17 #8 held only 🚀, and at 00:19:18 the bot posted `Opened #9.` |
| A job made to fail ends with 😕 and a `Failed:` line | #10's job `20261020-002015-e356` was stopped by the restart below. #10 held only 😕, then `Failed: dispatcher shut down. Job 20261020-002015-e356.` |
| Restarting the dispatcher during the job submits no second job and posts no second line | SIGTERM at 00:20:20, 4.4 s into #10's job, 17 s after its label. The new process re-read the event inside the 60 s cursor lag. One job was created after 00:20:00, and #10 has one comment |
| With your login removed from `EUMAEUS_INBOX_USERS`, the label starts nothing | with `EUMAEUS_INBOX_USERS=nobody-m7-check`, #7 was logged `labeled by clayharmon, not in EUMAEUS_INBOX_USERS: ignored`: no trigger, no job, no reaction, the label left on |
| `job_status` shows `trigger` | `{"kind": "label", "url": "https://github.com/clayharmon/eumaeus-fixtures/issues/8", "login": "clayharmon"}` |

What the build changed from the plan:

- A running job fails when the dispatcher stops: `dispatcher shut down` on SIGTERM, or `dispatcher restarted while
  job was running` after a crash. So the restart run is also the failure run.
- `job.sh` adds `new_commits` and `pr_opened` to the result. The line is `Opened #<pr>.` only when the job opened the
  PR. A job that pushed to a branch with a PR already open gets `Pushed 2 commits, up to 1a2b3c4.`
- Two lines the plan's table didn't list: `Cancelled. Job <id>.`, and `Pushed 2 commits to <branch>, up to 1a2b3c4.`
  when the branch has no PR.
- The label on a PR gets no reactions, only the reply. On PR #9 the label was off and the reply posted 1.5 s after
  the poll saw it.
- A label from someone not allowed stays on. Its log line is written once per process.
- When the dispatcher stopped between submitting a job and adding 👀, the next answer pass adds it while the job
  runs. The Check didn't exercise this.
- The task is cut at 20,000 characters, the `submit_job` limit, and ends with `[cut]`.
- PR #9 stays open: step 5's Check reviews it.

### Step 5: mentions

| Check | Result |
|---|---|
| A review on the step 4 PR with 2 inline comments and `@you-eumaeus` in its body starts one job whose commit addresses both | review 5579375668 on PR #9, posted at 00:28:14, was seen at 00:28:22 and started job `20261020-002821-1b06` (12 s, parent `20261020-001857-4697`). Its one commit turned the line into `Labeled from an issue.` The second inline comment also mentioned the app and started no job of its own |
| An inline comment `@you-eumaeus rename foo to bar` gets a commit and a reply in its thread | comment 4320254160 on PR #11 started job `20261020-002825-46d8`, which changed `const foo = 1;` to `const bar = 1;`. Reply 4320258334, in that thread: `Pushed 1 commit, up to d234929.` |
| A mention on a PR opened by hand pushes to its branch | on PR #11, opened by hand from `m7-hand`, comment 6280409946 started job `20261020-002824-3362`. It pushed `const baz = 2;` to `m7-hand` and answered `Pushed 1 commit, up to 327cf3c.` |
| A mention in an issue comment opens a PR | comment 6280410370 on #12 started job `20261020-002823-0304`, which opened PR #13 with a body ending in `Closes #12`. #12 got `Opened #13.` |
| A mention on a PR from a fork starts nothing | PR #14, from `oreibates/eumaeus-fixtures:m7-fork`: no job, no reaction, one reply: `This pull request's branch is in a fork, and the app can push only to clayharmon/eumaeus-fixtures. Nothing ran.` |
| A quoted mention starts nothing | comment 6280414243 on #11, `> @you-eumaeus rename foo to bar`: no trigger row, no log line |
| A review with no mention starts nothing | review 5579377950 on PR #9, with an inline comment and neither mentioning the app: no trigger row |

The 2 jobs on `m7-hand` ran one after the other. `46d8` was queued at 00:28:25, a slot was free from 00:28:36, and it
started at 00:28:45.458, 1 ms after `3362` finished.

What the build changed from the plan:

- GitHub has no repo-wide list of reviews. A review changes its PR's `updated_at` in the open-issue list, so the
  inbox reads the reviews of each PR updated after the cursor, and keeps reading them for 60 s after.
- A review's own comment list, `/pulls/{n}/reviews/{id}/comments`, leaves out line numbers. The first review job's
  task read `m7-step4.txt:?`. The inbox now reads the PR's comment list and keeps that review's comments. Review
  5579403130's job, `20261020-003259-c5de`, read `m7-step4.txt:1`, and its commit addressed both comments.
- Lines and the commit come from `original_line` and `original_commit_id`, the commit the comment was written on.
  `line` turned null on PR #9 once the review's job pushed.
- An inline comment that mentions the app, in a review whose body mentions it too, belongs to that review's job.
  The inbox reads the comment's review to tell, so the order the two are seen in doesn't matter.
- `parent_id` is the newest job that pushed to the PR's branch, even when a person pushed after it. The second
  review on PR #9 followed `20261020-002821-1b06`.
- A mention alone on a PR gets `` Write what to change after `@you-eumaeus`. A mention alone starts nothing. ``
  Checked with comment 6280519274 on #11.
- The bot's comments are never triggers, and its replies put the mention in backticks. The step 4 reply on PR #9
  had rendered `@you-eumaeus` as a live mention.
- A mention doesn't count right after a letter, digit, `@`, `.`, `/`, or `-`, so `me@you-eumaeus.com` starts nothing.
- A poll that reads past the issue list now reads 3 lists per repo, plus the reviews of each PR that changed. The
  first poll after a start made 202 requests for 50 repos. A quiet poll is still 50 requests, all `304`: the one at
  00:38:34 took 1.8 s.
- A reply in a thread goes to the thread's first comment, since GitHub refuses replies to replies.
- The fork `oreibates/eumaeus-fixtures` stays for later runs.

### Step 6: screenshots

| Check | Result |
|---|---|
| The step 1 `web` job, run again, shows its screenshot in the PR on github.com and in GitHub Mobile, on the fixtures repo | job `20261020-005130-da25` (Sonnet 5.5, 6 turns, $0.050) opened PR #15 with `desktop.png` and `mobile-375.png`, and both showed on github.com and in GitHub Mobile. Fetched without a login, the link returned a 375×700 PNG of 19,837 bytes |
| The same on a private repo | job `20261020-005130-7622` on `clayharmon/eumaeus-fixtures-private` opened PR #1 with 2 screenshots, and both showed on github.com and in GitHub Mobile. Fetched without a login, the link returned `404` |
| Two jobs saving screenshots at once both land on `eumaeus-screenshots` | `da25` and `fdc4` started 33 ms apart. `da25` pushed `186ce992` on try 1. `fdc4` was rejected with `reference already exists`, then pushed `6c62f264`, whose parent is `186ce992`, on try 2 |

What the build changed from the plan:

- Each screenshot commit holds only its own job's directory, with the branch's last commit as parent. The links name
  the commit, so they keep working, and the branch tip shows only the newest job. A `--depth=1` fetch of the tip
  stays at 12 MB or less, however many jobs came before.
- Jobs no longer use `git clone`. They run `git init`, `git fetch` with the refspec
  `^refs/heads/eumaeus-screenshots`, and `git checkout`, so the screenshots branch stays out of every clone.
  `git clone -c remote.origin.fetch=^refs/heads/eumaeus-screenshots` still fetched the branch. A `shell` job's
  clone afterward listed 21 remote branches, and `eumaeus-screenshots` wasn't one of them.
- On a PR that's already open, the job posts its screenshots in a comment, because the body belongs to whoever
  opened the PR. The Check didn't exercise this.
- Only `*.png` files count. Characters outside `A-Za-z0-9._-` become `_`, and a file over 2 MB is skipped and
  logged. A local test turned `page 1.png` into `page_1.png` and skipped a 2.2 MB file.
- In a local test, 4 jobs pushing at once all landed, the last on its 4th try, which is the limit.
- The job's result gains `screenshots`, a list of the links.
- In `body_html`, GitHub keeps the `github.com/.../blob/...?raw=true` link as the image source and doesn't proxy it.
  The viewer's own session loads it, which is why the image works on a private repo.
- The hand-off asks for PNGs of 2 MB at most.
- `clayharmon/eumaeus-fixtures-private` stays for later runs.

### Step 7: README

| Check | Result |
|---|---|
| `pnpm smoke <owner/repo>` passes with the inbox on, from "Done when" | job `20261020-005609-988a` pushed and opened PR #17 in 13.7 s, closed. The inbox watched 52 repos, and its last poll was 60 responses, all `304` |

What the build changed from the plan:

- The README gains "Starting jobs from GitHub" and "Browser", rows for `EUMAEUS_INBOX_USERS` and
  `EUMAEUS_INBOX_POLL_S`, and `trigger` in `job_status`. Its limits gain the trust rule, the Issues permission,
  and the 937 MB one Chromium page takes.
- The README tells you to set `EUMAEUS_INBOX_USERS` on one dispatcher per GitHub App, from the plan's edge cases.

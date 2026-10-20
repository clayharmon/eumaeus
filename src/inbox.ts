import type { Config } from './config.ts';
import { TERMINAL, type Db, type JobRow, type NewTrigger, type TriggerRow } from './db.ts';
import { ghApi, ghGet, RateLimited, type Conditional, type GitHubApp, type RateLimit } from './github.ts';
import type { Scheduler } from './jobs.ts';

/** The label that turns an issue into a job. The inbox never creates it; each repo creates it once. */
export const LABEL = 'eumaeus';
const REPOS_MS = 10 * 60_000;
/** Installation tokens last an hour and GitHub's ETags differ per token, so one token serves 50 min. */
const TOKEN_MS = 50 * 60_000;
/** An event can reach one endpoint a little after another shows it; the cursor trails each poll by this much. */
const LAG_MS = 60_000;
const PARALLEL = 8;
const MAX_PAGES = 10;
/** The longest task the inbox submits, as for submit_job. */
const TASK_CHARS = 20_000;

interface Issue {
  id: number; number: number; title: string; body: string | null; user: { login: string }; html_url: string;
  state: string; created_at: string; updated_at: string; pull_request?: object;
}
interface IssueEvent { id: number; event: string; actor: { login: string } | null; created_at: string; label?: { name: string }; issue?: Issue }
interface Comment { id: number; user: { login: string } | null; body: string | null; created_at: string; html_url: string; issue_url: string }
interface ReviewComment {
  id: number; user: { login: string } | null; body: string; created_at: string; html_url: string; pull_request_url: string;
  pull_request_review_id: number | null; in_reply_to_id?: number; path: string; original_line: number | null;
  diff_hunk: string; original_commit_id: string;
}
interface Review { id: number; user: { login: string } | null; body: string | null; submitted_at?: string; commit_id: string; html_url: string }
interface Pull { state: string; html_url: string; head: { ref: string; sha: string; repo: { full_name: string } | null }; base: { ref: string } }
/** A trigger before it has a job: who caused it, and where its 👀 and its answer go. */
type Found = Omit<NewTrigger, 'job_id' | 'reply'>;

interface Watched { repo: string; installation: number; account: string }

/**
 * Turns GitHub events by allowed users into jobs (docs/m7-github-inbox.md). GitHub can't reach the dispatcher, so
 * it polls every repo the app is installed on. Each repo's open-issue list, newest update first, is the one request
 * per poll; a 304 there means no issue or PR changed and the poll ends. Every request sends its ETag, so a quiet
 * repo costs no rate limit.
 */
export class Inbox {
  readonly off: string | null;
  private readonly db: Db;
  private readonly sched: Scheduler;
  private readonly app: GitHubApp | null;
  private readonly cfg: Config;
  private readonly log: (s: string) => void;
  private repos: Watched[] = [];
  private reposAt = 0;
  private readonly tokens = new Map<number, { token: string; until: number }>();
  private readonly etags = new Map<string, string>();
  /** Repo -> until when its other endpoints are read even on a 304 from the issue list: they can lag behind it. */
  private readonly dirty = new Map<string, number>();
  /** `<repo>#<n>` -> until when that PR's reviews are read. There is no repo-wide list of reviews. */
  private readonly dirtyPulls = new Map<string, number>();
  private readonly rates = new Map<string, RateLimit>();
  /** Lines logged once: an ignored event or a repo's repeated error shows up again on each poll. */
  private readonly logged = new Set<string>();
  private pausedUntil = 0;
  private busy = false;
  private lastPoll: { at: string; seconds: number; responses: Record<string, number> } | null = null;

  constructor(db: Db, sched: Scheduler, app: GitHubApp | null, cfg: Config, log: (s: string) => void) {
    this.db = db;
    this.sched = sched;
    this.app = app;
    this.cfg = cfg;
    this.log = log;
    this.off = !app ? `no GitHub App at ${cfg.githubAppFile}; mentions and answers need one`
      : cfg.inboxUsers.length === 0 ? 'EUMAEUS_INBOX_USERS is empty' : null;
  }

  start(): void {
    if (this.off || !this.app) { this.log(`inbox off: ${this.off}`); return; }
    this.log(`inbox: label ${LABEL} or @${this.app.cfg.slug} from ${this.cfg.inboxUsers.join(', ')}, every ${this.cfg.inboxPollMs / 1000} s`);
    void this.tick();
    setInterval(() => void this.tick(), this.cfg.inboxPollMs).unref();
  }

  /** For the MCP server's instructions: how to start a job from GitHub here, or null when the inbox is off. */
  describe(): string | null {
    if (this.off || !this.app) return null;
    return `the label \`${LABEL}\` on an open issue, or \`@${this.slug}\` in a new issue, an issue or PR comment, an inline ` +
      `review comment, or a review's body, by ${this.cfg.inboxUsers.join(', ')}, in any repo the GitHub App is installed on`;
  }

  /** For /healthz. */
  status(): Record<string, unknown> {
    if (this.off) return { off: this.off };
    return {
      users: this.cfg.inboxUsers,
      poll_s: this.cfg.inboxPollMs / 1000,
      repos: this.repos.map((w) => w.repo),
      last_poll: this.lastPoll,
      waiting: this.db.unanswered().length,
      rate: Object.fromEntries(this.rates),
      paused_until: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null,
    };
  }

  async tick(): Promise<void> {
    if (this.busy || Date.now() < this.pausedUntil) return;
    this.busy = true;
    const t0 = Date.now();
    const responses: Record<string, number> = {};
    try {
      await this.refreshRepos();
      const queue = [...this.repos];
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        for (let w = queue.shift(); w && Date.now() >= this.pausedUntil; w = queue.shift()) await this.poll(w, responses);
      }));
      this.lastPoll = { at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, responses };
      await this.answer();
    } catch (e) {
      this.fail('inbox', e);
    } finally {
      this.busy = false;
    }
  }

  private async refreshRepos(): Promise<void> {
    if (!this.app || Date.now() - this.reposAt < REPOS_MS) return;
    const found: Watched[] = [];
    for (const inst of await this.app.listInstallations()) {
      const token = await this.token(inst.id);
      for (let url: string | null = '/installation/repositories?per_page=100'; url;) {
        const page: Conditional<{ repositories: { full_name: string; archived: boolean }[] }> = await ghGet(url, token);
        for (const r of page.body?.repositories ?? []) {
          if (!r.archived) found.push({ repo: r.full_name, installation: inst.id, account: inst.account.login });
        }
        url = page.next;
      }
    }
    if (found.length !== this.repos.length) this.log(`inbox: watching ${found.length} repos`);
    this.repos = found;
    this.reposAt = Date.now();
  }

  private async token(installation: number): Promise<string> {
    const cached = this.tokens.get(installation);
    if (cached && cached.until > Date.now()) return cached.token;
    const { token } = await this.app!.installationTokenAll(installation);
    this.tokens.set(installation, { token, until: Date.now() + TOKEN_MS });
    return token;
  }

  /** One repo. The cursor and the ETags move only when every request in the poll succeeded. */
  private async poll(w: Watched, responses: Record<string, number>): Promise<void> {
    const started = Date.now();
    try {
      const token = await this.token(w.installation);
      let since = this.db.inboxSince(w.repo);
      if (!since) {
        // First sight of this repo: nothing that happened before now is a trigger.
        since = new Date(started).toISOString();
        this.db.setInboxCursor(w.repo, since, null);
      }
      const sinceMs = Date.parse(since);
      const etags = new Map<string, string>();
      /** Pages of a newest-first list, while the last item is newer than the cursor. Null on a 304. */
      const list = async <T>(path: string, newer: (item: T) => boolean): Promise<T[] | null> => {
        const first = await ghGet<T[]>(path, token, this.etags.get(path) ?? null);
        responses[first.status] = (responses[first.status] ?? 0) + 1;
        if (first.rate) this.rates.set(w.account, first.rate);
        if (first.status === 304 || !first.body) return null;
        if (first.etag) etags.set(path, first.etag);
        const items = [...first.body];
        for (let next = first.next, n = 1; next && n < MAX_PAGES && items.length && newer(items[items.length - 1]!); n++) {
          const page = await ghGet<T[]>(next, token);
          items.push(...(page.body ?? []));
          next = page.next;
        }
        return items;
      };
      const after = (t: string): boolean => Date.parse(t) > sinceMs;

      // The hour, not the cursor, goes in `since=`: the URL, and so its ETag, stays the same between polls.
      const hour = `${new Date(sinceMs).toISOString().slice(0, 13)}:00:00Z`;
      const issues = await list<Issue>(`/repos/${w.repo}/issues?state=open&sort=updated&direction=desc&per_page=100&since=${hour}`, (i) => after(i.updated_at));
      if (issues) this.dirty.set(w.repo, started + LAG_MS);
      for (const i of issues ?? []) {
        // A review changes its PR's updated_at, and that is the only sign of one.
        if (i.pull_request && after(i.updated_at)) this.dirtyPulls.set(`${w.repo}#${i.number}`, started + LAG_MS);
        else if (!i.pull_request && after(i.created_at)) await this.newIssue(w, i, token);
      }
      for (const [key, until] of this.dirtyPulls) {
        if (!key.startsWith(`${w.repo}#`)) continue;
        if (until <= started) { this.dirtyPulls.delete(key); continue; }
        const n = Number(key.slice(w.repo.length + 1));
        const reviews = await list<Review>(`/repos/${w.repo}/pulls/${n}/reviews?per_page=100`, () => true);
        for (const r of reviews ?? []) if (r.submitted_at && after(r.submitted_at)) await this.reviewed(w, n, r, token);
      }
      if ((this.dirty.get(w.repo) ?? 0) > started) {
        const events = await list<IssueEvent>(`/repos/${w.repo}/issues/events?per_page=100`, (e) => after(e.created_at));
        for (const e of events ?? []) {
          if (e.event === 'labeled' && e.label?.name === LABEL && after(e.created_at) && e.issue) await this.labeled(w, e, e.issue, token);
        }
        const comments = await list<Comment>(`/repos/${w.repo}/issues/comments?sort=created&direction=desc&per_page=100&since=${hour}`, (c) => after(c.created_at));
        for (const c of comments ?? []) if (after(c.created_at)) await this.commented(w, c, token);
        const inline = await list<ReviewComment>(`/repos/${w.repo}/pulls/comments?sort=created&direction=desc&per_page=100&since=${hour}`, (c) => after(c.created_at));
        for (const c of inline ?? []) if (after(c.created_at)) await this.inline(w, c, token);
      }

      const next = Math.max(sinceMs, started - LAG_MS);
      this.db.setInboxCursor(w.repo, new Date(next).toISOString(), new Date().toISOString());
      for (const [k, v] of etags) this.etags.set(k, v);
      this.logged.delete(`error ${w.repo}`);
    } catch (e) {
      this.fail(w.repo, e);
    }
  }

  /**
   * The label on an issue starts a job and comes off, so adding it again is a retry. On a PR it only comes off,
   * with a reply. A throw before the trigger is recorded fails the poll, which then sees the event again.
   */
  private async labeled(w: Watched, e: IssueEvent, issue: Issue, token: string): Promise<void> {
    const id = `label:${e.id}`;
    const login = e.actor?.login ?? '?';
    const where = `${id} ${w.repo}#${issue.number} labeled by ${login}`;
    if (!this.fresh(id, login, where)) return;
    if (issue.state !== 'open') { this.once(id, `inbox: ${where}, closed: skipped`); return; }
    const found = onIssue(w.repo, id, issue, login);
    if (issue.pull_request) {
      // In backticks: the reply would otherwise mention the app.
      this.db.insertTrigger({ ...found, job_id: null, reply: `The ${LABEL} label starts a job from an issue. On a pull request, mention \`@${this.slug}\` with what to change.` });
      this.log(`inbox: ${where}, a pull request: replying`);
    } else {
      await this.startIssue(w, issue, found, where, token);
    }
    await ghApi(`/repos/${w.repo}/issues/${issue.number}/labels/${LABEL}`, token, { method: 'DELETE' })
      .catch((err: unknown) => this.fail(`${id} label`, err));
  }

  /** A new issue whose body mentions the app: the same job as the label. */
  private async newIssue(w: Watched, issue: Issue, token: string): Promise<void> {
    if (!mentions(issue.body ?? '', this.slug)) return;
    const id = `issue:${issue.id}`;
    const where = `${id} ${w.repo}#${issue.number} by ${issue.user.login}`;
    if (!this.fresh(id, issue.user.login, where)) return;
    await this.startIssue(w, issue, onIssue(w.repo, id, issue, issue.user.login), where, token);
  }

  /** A comment on an issue starts the issue's job; a comment on a PR asks for a change on its branch. */
  private async commented(w: Watched, c: Comment, token: string): Promise<void> {
    const login = c.user?.login ?? '?';
    if (login === this.app!.botLogin || !mentions(c.body ?? '', this.slug)) return;
    const n = Number(c.issue_url.slice(c.issue_url.lastIndexOf('/') + 1));
    const id = `comment:${c.id}`;
    const where = `${id} ${w.repo}#${n} by ${login}`;
    if (!this.fresh(id, login, where)) return;
    const found: Found = {
      id, repo: w.repo, number: n, url: c.html_url, login,
      react_path: `/repos/${w.repo}/issues/comments/${c.id}/reactions`, reply_path: `/repos/${w.repo}/issues/${n}/comments`,
    };
    if (c.html_url.includes('/pull/')) {
      await this.startPull(w, found, (c.body ?? '').trim(), !asksSomething(c.body ?? '', this.slug), null, token);
      return;
    }
    const issue = await ghApi<Issue>(`/repos/${w.repo}/issues/${n}`, token);
    if (issue.state !== 'open') { this.once(id, `inbox: ${where}, closed: skipped`); return; }
    await this.startIssue(w, issue, found, where, token);
  }

  /** An inline review comment, unless its review's body mentions the app: then the review is the trigger. */
  private async inline(w: Watched, c: ReviewComment, token: string): Promise<void> {
    const login = c.user?.login ?? '?';
    if (login === this.app!.botLogin || !mentions(c.body, this.slug)) return;
    const n = Number(c.pull_request_url.slice(c.pull_request_url.lastIndexOf('/') + 1));
    const id = `review-comment:${c.id}`;
    const where = `${id} ${w.repo}#${n} by ${login}`;
    if (!this.fresh(id, login, where)) return;
    if (c.pull_request_review_id !== null) {
      if (this.db.hasTrigger(`review:${c.pull_request_review_id}`)) return;
      const r = await ghApi<Review>(`/repos/${w.repo}/pulls/${n}/reviews/${c.pull_request_review_id}`, token);
      if (r.user && this.allowed(r.user.login) && mentions(r.body ?? '', this.slug)) { await this.reviewed(w, n, r, token); return; }
    }
    const found: Found = {
      id, repo: w.repo, number: n, url: c.html_url, login,
      // GitHub takes replies only to the first comment of a thread.
      react_path: `/repos/${w.repo}/pulls/comments/${c.id}/reactions`, reply_path: `/repos/${w.repo}/pulls/${n}/comments/${c.in_reply_to_id ?? c.id}/replies`,
    };
    const ask = [`${c.path}:${c.original_line ?? '?'}:`, '```diff', ...c.diff_hunk.split('\n').slice(-5), '```', '', c.body.trim()].join('\n');
    await this.startPull(w, found, ask, !asksSomething(c.body, this.slug), c.original_commit_id, token);
  }

  /** A review whose body mentions the app: one job for the body and every inline comment of the review. */
  private async reviewed(w: Watched, n: number, r: Review, token: string): Promise<void> {
    if (!mentions(r.body ?? '', this.slug)) return;
    const login = r.user?.login ?? '?';
    const id = `review:${r.id}`;
    const where = `${id} ${w.repo}#${n} by ${login}`;
    if (!this.fresh(id, login, where)) return;
    // The PR's list, not the review's: the review's leaves out the line numbers.
    const comments: ReviewComment[] = [];
    for (let url: string | null = `/repos/${w.repo}/pulls/${n}/comments?per_page=100`; url;) {
      const page: Conditional<ReviewComment[]> = await ghGet(url, token);
      comments.push(...(page.body ?? []).filter((c) => c.pull_request_review_id === r.id));
      url = page.next;
    }
    const found: Found = {
      id, repo: w.repo, number: n, url: r.html_url, login,
      // GitHub has no reactions on a review, so its 👀 goes on the PR.
      react_path: `/repos/${w.repo}/issues/${n}/reactions`, reply_path: `/repos/${w.repo}/issues/${n}/comments`,
    };
    const lines = comments.map((c) => `- ${c.path}:${c.original_line ?? '?'}: ${c.body.trim().replaceAll('\n', '\n  ')}`);
    const ask = [r.body!.trim(), ...(lines.length ? ['', ...lines] : [])].join('\n');
    await this.startPull(w, found, ask, !asksSomething(r.body!, this.slug) && lines.length === 0, r.commit_id, token);
  }

  private async startIssue(w: Watched, issue: Issue, found: Found, where: string, token: string): Promise<void> {
    const job = await this.issueJob(w, issue, found, token);
    this.log(`inbox: ${where}: job ${job.id}`);
    await this.eyes(found, token);
  }

  /**
   * A job on the PR's head branch. When an eumaeus job pushed there, the new job takes its runner and model and
   * appends its task, as a CI fix does. A fork's branch, or a mention with nothing else, gets a reply instead.
   */
  private async startPull(w: Watched, found: Found, ask: string, empty: boolean, sha: string | null, token: string): Promise<void> {
    const where = `${found.id} ${w.repo}#${found.number} by ${found.login}`;
    const pr = await ghApi<Pull>(`/repos/${w.repo}/pulls/${found.number}`, token);
    if (pr.state !== 'open') { this.once(found.id, `inbox: ${where}, closed: skipped`); return; }
    const reply = pr.head.repo?.full_name.toLowerCase() !== w.repo.toLowerCase()
      ? `This pull request's branch is in a fork, and the app can push only to ${w.repo}. Nothing ran.`
      : empty ? `Write what to change after \`@${this.slug}\`. A mention alone starts nothing.` : null;
    if (reply) {
      this.db.insertTrigger({ ...found, job_id: null, reply });
      this.log(`inbox: ${where}: replying, ${empty ? 'nothing asked' : 'a fork'}`);
      return;
    }
    const parent = this.db.lastPushed(w.repo, pr.head.ref);
    const task = [
      `@${found.login} asked on pull request ${pr.html_url} at commit ${(sha ?? pr.head.sha).slice(0, 8)}. You are on that branch. Do what they ask, run the checks the change touches, and commit.`,
      '',
      ask,
      ...(parent ? ['', 'The task that produced this branch:', parent.task.length > 4_000 ? `${parent.task.slice(0, 4_000)}\n[cut]` : parent.task] : []),
    ].join('\n');
    const job = this.db.transaction(() => {
      const job = this.sched.submit({
        repo: w.repo, task: cap(task), runner: parent?.runner ?? 'claude', model: parent?.model ?? undefined,
        base_branch: pr.base.ref, branch: pr.head.ref, parent_id: parent?.id,
      });
      this.db.insertTrigger({ ...found, job_id: job.id, reply: null });
      return job;
    });
    this.log(`inbox: ${where}: job ${job.id} on ${pr.head.ref}${parent ? `, after ${parent.id}` : ''}`);
    await this.eyes(found, token);
  }

  /** A job on a new branch from the default branch whose task is the issue, and whose PR closes it. */
  private async issueJob(w: Watched, issue: Issue, found: Found, token: string): Promise<JobRow> {
    const { default_branch } = await ghApi<{ default_branch: string }>(`/repos/${w.repo}`, token);
    const comments: Comment[] = [];
    for (let url: string | null = `/repos/${w.repo}/issues/${issue.number}/comments?per_page=100`; url;) {
      const page: Conditional<Comment[]> = await ghGet(url, token);
      comments.push(...(page.body ?? []));
      url = page.next;
    }
    // The person who added the label vouches for the issue's body; other people's comments stay out.
    const allowed = comments.filter((c) => c.user && this.allowed(c.user.login) && c.body?.trim());
    const task = [
      `Resolve issue ${issue.html_url}: ${issue.title}`,
      '',
      issue.body?.trim() || '(no description)',
      ...(allowed.length ? ['', 'Comments from allowed users:', ...allowed.map((c) => `- @${c.user!.login}: ${c.body!.trim().replaceAll('\n', '\n  ')}`)] : []),
    ].join('\n');
    // One transaction: a crash leaves both rows or neither, so a restart neither loses the trigger nor runs it twice.
    return this.db.transaction(() => {
      const job = this.sched.submit({
        repo: w.repo, task: cap(task), runner: 'claude',
        base_branch: default_branch, pr_footer: `Closes #${issue.number}`,
      });
      this.db.insertTrigger({ ...found, job_id: job.id, reply: null });
      return job;
    });
  }

  private async eyes(t: Pick<TriggerRow, 'id' | 'react_path'>, token: string): Promise<void> {
    try {
      const r = await ghApi<{ id: number }>(t.react_path, token, { method: 'POST', body: JSON.stringify({ content: 'eyes' }) });
      this.db.setTriggerEyes(t.id, r.id);
    } catch (e) {
      this.fail(`${t.id} eyes`, e);
    }
  }

  /**
   * When a trigger's job ends: 👀 off, 🚀 or 😕 on, then one line. replied_at is set right after the line, so a
   * restart neither loses an answer nor posts it twice.
   */
  private async answer(): Promise<void> {
    for (const t of this.db.unanswered()) {
      const w = this.repos.find((r) => r.repo === t.repo);
      if (!w) continue;
      try {
        const token = await this.token(w.installation);
        const job = t.job_id ? this.db.get(t.job_id) : undefined;
        if (job && !TERMINAL.has(job.status)) {
          // The dispatcher stopped between submitting the job and reacting.
          if (t.eyes_id === null) await this.eyes(t, token);
          continue;
        }
        let line = t.reply ?? '';
        if (job) {
          if (t.eyes_id !== null) {
            await ghApi(`${t.react_path}/${t.eyes_id}`, token, { method: 'DELETE' }).catch((e: unknown) => {
              if (!(e instanceof Error && / -> 404: /.test(e.message))) throw e;
            });
          }
          const ok = job.status === 'pushed' || job.status === 'no_changes';
          await ghApi(t.react_path, token, { method: 'POST', body: JSON.stringify({ content: ok ? 'rocket' : 'confused' }) });
          line = outcomeLine(job);
        }
        await ghApi(t.reply_path, token, { method: 'POST', body: JSON.stringify({ body: line }) });
        this.db.setReplied(t.id, line);
        this.log(`inbox: ${t.id} answered: ${line}`);
      } catch (e) {
        this.fail(`${t.id} answer`, e);
      }
    }
  }

  private get slug(): string {
    return this.app!.cfg.slug;
  }

  private allowed(login: string): boolean {
    return this.cfg.inboxUsers.includes(login.toLowerCase());
  }

  /** False when the trigger was seen before, or when someone not allowed caused it (logged once). */
  private fresh(id: string, login: string, where: string): boolean {
    if (this.db.hasTrigger(id)) return false;
    if (this.allowed(login)) return true;
    this.once(id, `inbox: ${where}, not in EUMAEUS_INBOX_USERS: ignored`);
    return false;
  }

  private fail(where: string, e: unknown): void {
    if (e instanceof RateLimited) {
      this.pausedUntil = Math.max(this.pausedUntil, e.until);
      this.log(`inbox: paused, ${e.message}`);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    this.once(`error ${where}`, `inbox ${where}: ${msg}`);
  }

  private once(key: string, line: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.log(line);
  }
}

/** A trigger on an issue, or on a PR through its issue: 👀 on it, the answer as a comment. */
function onIssue(repo: string, id: string, issue: Issue, login: string): Found {
  return {
    id, repo, number: issue.number, url: issue.html_url, login,
    react_path: `/repos/${repo}/issues/${issue.number}/reactions`, reply_path: `/repos/${repo}/issues/${issue.number}/comments`,
  };
}

function cap(task: string): string {
  return task.length > TASK_CHARS ? `${task.slice(0, TASK_CHARS)}\n[cut]` : task;
}

/** The lines where a mention counts: outside fenced code and quoted lines, with inline code removed. */
function prose(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && !/^\s*>/.test(line)) out.push(line.replace(/`[^`]*`/g, ''));
  }
  return out.join('\n');
}

/** `@<slug>`, matched without regard to case, not inside a word or an email address, and not followed by a login character. */
function mentionRe(slug: string, flags = 'i'): RegExp {
  return new RegExp(`(^|[^\\w@./-])@${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, flags);
}

export function mentions(text: string, slug: string): boolean {
  return mentionRe(slug).test(prose(text));
}

/** Whether the text says anything once its mentions are taken out. */
function asksSomething(text: string, slug: string): boolean {
  return prose(text).replace(mentionRe(slug, 'gi'), '$1').trim() !== '';
}

/** The line posted when a trigger's job ends. */
export function outcomeLine(j: JobRow): string {
  const r = j.result ? (JSON.parse(j.result) as Record<string, unknown>) : {};
  if (j.status === 'pushed') {
    const pr = typeof r['pr_url'] === 'string' ? /\/pull\/(\d+)/.exec(r['pr_url'])?.[1] : undefined;
    if (pr && r['pr_opened'] === true) return `Opened #${pr}.`;
    const n = typeof r['new_commits'] === 'number' ? r['new_commits'] : null;
    const sha = typeof r['commit'] === 'string' ? r['commit'].slice(0, 7) : '?';
    const pushed = n === null ? 'Pushed' : `Pushed ${n} commit${n === 1 ? '' : 's'}`;
    return pr ? `${pushed}, up to ${sha}.` : `${pushed} to ${j.branch}, up to ${sha}.`;
  }
  if (j.status === 'no_changes') return `No changes. Job ${j.id}.`;
  if (j.status === 'cancelled') return `Cancelled. Job ${j.id}.`;
  return `Failed: ${j.error ?? 'unknown error'}. Job ${j.id}.`;
}

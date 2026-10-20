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
interface Comment { id: number; user: { login: string } | null; body: string | null; created_at: string; html_url: string }
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
      if (issues || (this.dirty.get(w.repo) ?? 0) > started) {
        const events = await list<IssueEvent>(`/repos/${w.repo}/issues/events?per_page=100`, (e) => after(e.created_at));
        for (const e of events ?? []) {
          if (e.event === 'labeled' && e.label?.name === LABEL && after(e.created_at) && e.issue) await this.labeled(w, e, e.issue, token);
        }
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
    if (this.db.hasTrigger(id)) return;
    const login = e.actor?.login ?? '?';
    const where = `${id} ${w.repo}#${issue.number} labeled by ${login}`;
    if (!this.allowed(login)) { this.once(id, `inbox: ${where}, not in EUMAEUS_INBOX_USERS: ignored`); return; }
    if (issue.state !== 'open') { this.once(id, `inbox: ${where}, closed: skipped`); return; }
    const found: Found = {
      id, repo: w.repo, number: issue.number, url: issue.html_url, login,
      react_path: `/repos/${w.repo}/issues/${issue.number}/reactions`, reply_path: `/repos/${w.repo}/issues/${issue.number}/comments`,
    };
    if (issue.pull_request) {
      this.db.insertTrigger({ ...found, job_id: null, reply: `The ${LABEL} label starts a job from an issue. On a pull request, mention @${this.app!.cfg.slug} with what to change.` });
      this.log(`inbox: ${where}, a pull request: replying`);
    } else {
      const job = await this.issueJob(w, issue, found, token);
      this.log(`inbox: ${where}: job ${job.id}`);
      await this.eyes(found, token);
    }
    await ghApi(`/repos/${w.repo}/issues/${issue.number}/labels/${LABEL}`, token, { method: 'DELETE' })
      .catch((err: unknown) => this.fail(`${id} label`, err));
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
        repo: w.repo, task: task.length > TASK_CHARS ? `${task.slice(0, TASK_CHARS)}\n[cut]` : task, runner: 'claude',
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

  private allowed(login: string): boolean {
    return this.cfg.inboxUsers.includes(login.toLowerCase());
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

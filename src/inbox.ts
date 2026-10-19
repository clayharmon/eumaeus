import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { ghGet, RateLimited, type Conditional, type GitHubApp, type RateLimit } from './github.ts';
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

interface Issue {
  id: number; number: number; title: string; body: string | null; user: { login: string }; html_url: string;
  state: string; created_at: string; updated_at: string; pull_request?: object;
}
interface IssueEvent { id: number; event: string; actor: { login: string } | null; created_at: string; label?: { name: string }; issue?: Issue }

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
          if (e.event === 'labeled' && e.label?.name === LABEL && after(e.created_at) && e.issue) this.labeled(w, e, e.issue);
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

  private labeled(w: Watched, e: IssueEvent, issue: Issue): void {
    const login = e.actor?.login ?? '?';
    const allowed = this.cfg.inboxUsers.includes(login.toLowerCase());
    this.once(`label:${e.id}`, `inbox: label:${e.id} ${w.repo}#${issue.number} labeled by ${login}${allowed ? '' : ', not in EUMAEUS_INBOX_USERS: ignored'}`);
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

import { appendFileSync } from 'node:fs';
import type { Config } from './config.ts';
import type { CredentialSource } from './credentials.ts';
import type { CiStatus, Db, JobRow } from './db.ts';
import { ghApi } from './github.ts';
import type { Scheduler } from './jobs.ts';

const POLL_MS = 30_000;
/** A commit with no check or status this long after the push has no CI. */
const NO_CHECKS_MS = 5 * 60_000;
const TOKEN_TTL_MS = 30 * 60_000;
/** Conclusions that pass, and conclusions an agent can act on. Anything else (cancelled, stale) is recorded, not fixed. */
const PASSED = new Set(['success', 'neutral', 'skipped']);
const FIXABLE = new Set(['failure', 'timed_out', 'startup_failure', 'error']);
const LOG_LINES = 150;
const TASK_LOG_CHARS = 15_000;

interface Check {
  kind: 'check' | 'status';
  id: number | null;
  name: string;
  done: boolean;
  conclusion: string;
  url: string | null;
  /** The app that reported a check run; `github-actions` has downloadable logs. */
  app: string | null;
  summary: string | null;
}

/** Stored as JSON in jobs.ci. */
interface CiDetail {
  sha: string;
  since: string;
  /** Fingerprint of a finished set of checks, seen once; a second identical poll settles it. */
  settle?: string;
  checks?: { name: string; conclusion: string; url: string | null }[];
  followup?: string;
  note?: string;
}

interface CheckRunsResponse {
  check_runs: {
    id: number; name: string; status: string; conclusion: string | null; html_url: string | null;
    app: { slug: string } | null; output: { title: string | null; summary: string | null } | null;
  }[];
}
interface StatusResponse { statuses: { context: string; state: string; target_url: string | null; description: string | null }[] }
interface Annotation { path: string; start_line: number; annotation_level: string; message: string }

/**
 * Watches the checks on every pushed job's commit, from the dispatcher rather than the VM, so a 15-minute CI run
 * holds no job slot. A failure with fix attempts left submits a follow-up job on the same branch with the failing
 * checks, their annotations, and the log tail. State lives in jobs.ci_status, so a restart resumes the watch.
 */
export class CiWatcher {
  private readonly db: Db;
  private readonly sched: Scheduler;
  private readonly creds: CredentialSource;
  private readonly cfg: Config;
  private readonly log: (s: string) => void;
  private readonly tokens = new Map<string, { token: string; until: number }>();
  private busy = false;

  constructor(db: Db, sched: Scheduler, creds: CredentialSource, cfg: Config, log: (s: string) => void) {
    this.db = db;
    this.sched = sched;
    this.creds = creds;
    this.cfg = cfg;
    this.log = log;
  }

  start(): void {
    setInterval(() => void this.tick(), POLL_MS).unref();
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const job of this.db.ciPending()) {
        try {
          await this.check(job);
        } catch (e) {
          // A network error or a 5xx: keep the job pending and try again next poll.
          this.log(`ci ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async check(job: JobRow): Promise<void> {
    const d = JSON.parse(job.ci ?? '{}') as CiDetail;
    const age = Date.now() - Date.parse(d.since);
    if (age > this.cfg.ciTimeoutMs) {
      this.settle(job, 'timeout', { ...d, note: `checks had not finished after ${Math.round(this.cfg.ciTimeoutMs / 60_000)} min` });
      return;
    }
    const token = await this.token(job.repo);
    let checks: Check[];
    try {
      checks = await this.checks(job.repo, d.sha, token);
    } catch (e) {
      if (e instanceof Error && / -> 403: /.test(e.message)) {
        this.settle(job, 'unavailable', { ...d, note: 'the GitHub App needs read access to Checks, Commit statuses, and Actions (README, "CI")' });
        return;
      }
      throw e;
    }

    if (checks.length === 0) {
      if (age > NO_CHECKS_MS) this.settle(job, 'none', { ...d, note: `no checks or statuses ${NO_CHECKS_MS / 60_000} min after the push` });
      return;
    }
    if (!checks.every((c) => c.done)) {
      if (d.settle) this.db.setCi(job.id, 'pending', { sha: d.sha, since: d.since });
      return;
    }
    // A slower workflow can register after the first ones finish: wait for the same finished set twice.
    const fingerprint = checks.map((c) => `${c.name}=${c.conclusion}`).sort().join(',');
    if (d.settle !== fingerprint) {
      this.db.setCi(job.id, 'pending', { ...d, settle: fingerprint });
      return;
    }

    const summary = checks.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url }));
    const failed = checks.filter((c) => !PASSED.has(c.conclusion));
    if (failed.length === 0) {
      this.settle(job, 'success', { sha: d.sha, since: d.since, checks: summary });
      return;
    }
    const fixable = failed.filter((c) => FIXABLE.has(c.conclusion));
    const left = job.ci_fix ?? 0;
    let note: string;
    let followup: string | undefined;
    if (job.runner === 'shell') note = 'shell jobs are watched, not fixed';
    else if (left <= 0) note = 'no fix attempts left';
    else if (fixable.length === 0) note = `no failure an agent can act on (${failed.map((c) => c.conclusion).join(', ')})`;
    else {
      // Someone pushed after this commit; a fix for the old commit would work on a head its task doesn't describe.
      const head = await branchHead(job.repo, job.branch, token);
      if (head === null) note = `branch ${job.branch} no longer exists`;
      else if (head !== d.sha) note = `superseded by ${head.slice(0, 8)}`;
      else {
        followup = this.submitFix(job, d.sha, fixable, await this.failureText(job.repo, fixable, token)).id;
        note = `follow-up job ${followup} (${left - 1} fix attempt(s) left after it)`;
      }
    }
    this.settle(job, 'failure', { sha: d.sha, since: d.since, checks: summary, ...(followup ? { followup } : {}), note });
  }

  private settle(job: JobRow, status: CiStatus, detail: CiDetail): void {
    this.db.setCi(job.id, status, detail);
    const line = `[ci] ${new Date().toISOString()} ${status}${detail.checks ? `: ${detail.checks.map((c) => `${c.name} ${c.conclusion}`).join(', ')}` : ''}${detail.note ? `; ${detail.note}` : ''}`;
    try { appendFileSync(this.sched.logPath(job.id), `${line}\n`); } catch { /* the log is best effort */ }
    this.log(`ci ${job.id}: ${status}${detail.note ? ` (${detail.note})` : ''}`);
  }

  private async checks(repo: string, sha: string, token: string): Promise<Check[]> {
    const runs = await ghApi<CheckRunsResponse>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, token);
    const status = await ghApi<StatusResponse>(`/repos/${repo}/commits/${sha}/status`, token);
    return [
      ...runs.check_runs.map((r): Check => ({
        kind: 'check', id: r.id, name: r.name, done: r.status === 'completed', conclusion: r.conclusion ?? r.status,
        url: r.html_url, app: r.app?.slug ?? null, summary: [r.output?.title, r.output?.summary].filter(Boolean).join('\n') || null,
      })),
      ...status.statuses.map((s): Check => ({
        kind: 'status', id: null, name: s.context, done: s.state !== 'pending', conclusion: s.state,
        url: s.target_url, app: null, summary: s.description,
      })),
    ];
  }

  /** What the follow-up agent reads: annotations and the log up to the last error, per failed check. */
  private async failureText(repo: string, failed: Check[], token: string): Promise<string> {
    const parts: string[] = [];
    for (const c of failed.slice(0, 3)) {
      const lines = [`### ${c.name}: ${c.conclusion}${c.url ? ` (${c.url})` : ''}`];
      if (c.summary) lines.push(c.summary.slice(0, 1_000));
      if (c.kind === 'check' && c.id !== null) {
        const all = await ghApi<Annotation[]>(`/repos/${repo}/check-runs/${c.id}/annotations?per_page=50`, token).catch(() => []);
        // Runners add warning and notice annotations about themselves; the failures are what the agent needs.
        const notes = all.filter((a) => a.annotation_level === 'failure').slice(0, 20);
        if (notes.length) lines.push('Annotations:', ...notes.map((a) => `- ${a.path}:${a.start_line}: ${a.message}`));
        if (c.app === 'github-actions') {
          const log = await actionsLogTail(repo, c.id, token);
          lines.push(log ? `Log, up to the last error:\n\`\`\`\n${log}\n\`\`\`` : 'Log: not available to this token.');
        }
      }
      parts.push(lines.join('\n'));
    }
    const text = parts.join('\n\n');
    return text.length > TASK_LOG_CHARS ? `${text.slice(0, TASK_LOG_CHARS)}\n[cut at ${TASK_LOG_CHARS} characters]` : text;
  }

  private submitFix(job: JobRow, sha: string, failed: Check[], failureText: string): JobRow {
    const result = job.result ? (JSON.parse(job.result) as Record<string, unknown>) : {};
    const where = typeof result['pr_url'] === 'string' ? `pull request ${result['pr_url']}` : `branch ${job.branch}`;
    const task = [
      `CI failed on ${where} at commit ${sha.slice(0, 8)}, which eumaeus job ${job.id} pushed. You are on that branch.`,
      `Make the failing checks pass and commit the fix. Run the failing commands in this VM before you commit; it has the repo's environment. Change only what the failure needs.`,
      '',
      `Failing: ${failed.map((c) => c.name).join(', ')}`,
      '',
      failureText,
      '',
      'The task that produced this branch:',
      job.task.length > 4_000 ? `${job.task.slice(0, 4_000)}\n[cut]` : job.task,
    ].join('\n');
    const child = this.sched.submit({
      repo: job.repo, task, runner: job.runner, model: job.model ?? undefined, base_branch: job.base_branch,
      branch: job.branch, cpus: job.cpus, memory: job.memory, parent_id: job.id, ci_fix: (job.ci_fix ?? 1) - 1,
    });
    return child;
  }

  /** Installation tokens last an hour; reuse one for 30 min rather than minting one per poll. */
  private async token(repo: string): Promise<string> {
    const cached = this.tokens.get(repo);
    if (cached && cached.until > Date.now()) return cached.token;
    const { token } = await this.creds.identityFor(repo);
    this.tokens.set(repo, { token, until: Date.now() + TOKEN_TTL_MS });
    return token;
  }
}

/** The commit a branch points at, or null when GitHub has no such branch. */
async function branchHead(repo: string, branch: string, token: string): Promise<string | null> {
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  try {
    return (await ghApi<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${ref}`, token)).object.sha;
  } catch (e) {
    if (e instanceof Error && / -> 404: /.test(e.message)) return null;
    throw e;
  }
}

/** The Actions job log up to its last `##[error]` line, the last 150 lines of that, timestamps and colors removed. */
async function actionsLogTail(repo: string, jobId: number, token: string): Promise<string | null> {
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'eumaeus' },
  }).catch(() => null);
  if (!r?.ok) return null;
  const lines = (await r.text()).split('\n').map((l) =>
    l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, '').replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400));
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('##[error]')) { end = i + 1; break; }
  }
  return lines.slice(Math.max(0, end - LOG_LINES), end).join('\n');
}

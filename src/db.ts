import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const JOB_STATUSES = ['queued', 'running', 'pushed', 'no_changes', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['pushed', 'no_changes', 'failed', 'cancelled']);
/** CI on a pushed job's commit (src/ci.ts). Null: never pushed, so never watched. */
export const CI_STATUSES = ['pending', 'success', 'failure', 'none', 'timeout', 'unavailable'] as const;
export type CiStatus = (typeof CI_STATUSES)[number];

export interface JobRow {
  id: string;
  repo: string;
  task: string;
  runner: string;
  model: string | null;
  base_branch: string;
  branch: string;
  cpus: number;
  memory: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  result: string | null;
  error: string | null;
  /** The job whose failing CI this job was submitted to fix, or whose branch a mention on its PR asked to change. */
  parent_id: string | null;
  /** Follow-up jobs this job may start when its CI fails. */
  ci_fix: number | null;
  ci_status: CiStatus | null;
  /** JSON: the commit, the checks, the follow-up job, and a note. */
  ci: string | null;
  /** Appended to the body of a PR the job opens, e.g. `Closes #12` for a job from an issue. */
  pr_footer: string | null;
  /** `replace`: the job rewrites the open PR's title and body from /work/pr.md. Null: the body belongs to whoever opened the PR. */
  pr_body: string | null;
  /** JSON array of job ids this job waits for. It starts once each has ended with a status in after_status. */
  after: string | null;
  /** JSON array of statuses; null when `after` is null. */
  after_status: string | null;
}

export const DEFAULT_AFTER_STATUS: readonly JobStatus[] = ['pushed', 'no_changes'];

/** A GitHub event the inbox turned into a job or a reply (src/inbox.ts). One row per event, ever. */
export interface TriggerRow {
  /** label:<event id>, issue:<issue id>, comment:<comment id>, review-comment:<comment id>, or review:<review id>. */
  id: string;
  repo: string;
  /** The issue or pull request number. */
  number: number;
  url: string;
  login: string;
  /** Null when the trigger only gets a reply, such as a mention on a fork's PR. */
  job_id: string | null;
  /** API paths: where 👀 and the outcome reaction go, and where the line is posted. */
  react_path: string;
  reply_path: string;
  eyes_id: number | null;
  /** Set when there is nothing to wait for; otherwise written from the job's outcome. */
  reply: string | null;
  created_at: string;
  replied_at: string | null;
}

export type NewJob = Pick<JobRow, 'id' | 'repo' | 'task' | 'runner' | 'model' | 'base_branch' | 'branch' | 'cpus' | 'memory' | 'parent_id' | 'ci_fix' | 'pr_footer' | 'pr_body' | 'after' | 'after_status'>;
export type NewTrigger = Omit<TriggerRow, 'eyes_id' | 'created_at' | 'replied_at'>;

/** Columns added after M4; an older database gets them on open. */
const ADDED_COLUMNS: Record<string, string> = { parent_id: 'TEXT', ci_fix: 'INTEGER', ci_status: 'TEXT', ci: 'TEXT', pr_footer: 'TEXT', pr_body: 'TEXT', after: 'TEXT', after_status: 'TEXT' };

const now = (): string => new Date().toISOString();

export class Db {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'eumaeus.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        task TEXT NOT NULL,
        runner TEXT NOT NULL,
        model TEXT,
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        cpus INTEGER NOT NULL,
        memory TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        result TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_status_created ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        url TEXT NOT NULL,
        login TEXT NOT NULL,
        job_id TEXT,
        react_path TEXT NOT NULL,
        reply_path TEXT NOT NULL,
        eyes_id INTEGER,
        reply TEXT,
        created_at TEXT NOT NULL,
        replied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS triggers_job ON triggers(job_id);
      -- since: events created at or before it are never triggers. A repo's first poll sets it to that moment.
      CREATE TABLE IF NOT EXISTS inbox_cursors (repo TEXT PRIMARY KEY, since TEXT NOT NULL, polled_at TEXT);
    `);
    const have = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    }
  }

  insert(j: NewJob): JobRow {
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo, task, runner, model, base_branch, branch, cpus, memory, parent_id, ci_fix, pr_footer, pr_body, after, after_status, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(j.id, j.repo, j.task, j.runner, j.model, j.base_branch, j.branch, j.cpus, j.memory, j.parent_id, j.ci_fix, j.pr_footer, j.pr_body, j.after, j.after_status, now());
    return this.get(j.id) as JobRow;
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  list(status: JobStatus | null, limit: number): JobRow[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows as unknown as JobRow[];
  }

  /**
   * Move the oldest queued job to running, skipping jobs whose branch a running job holds (two pushes to one branch
   * at once fail the second as a non-fast-forward) and jobs waiting on a job that is still queued or running.
   * Single-process, synchronous, so this is atomic.
   */
  claimNext(): JobRow | undefined {
    const row = this.db
      .prepare(
        `SELECT q.id FROM jobs q WHERE q.status = 'queued' AND NOT EXISTS (
           SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.repo = q.repo COLLATE NOCASE AND r.branch = q.branch
         ) AND NOT EXISTS (
           SELECT 1 FROM json_each(COALESCE(q.after, '[]')) a JOIN jobs w ON w.id = a.value WHERE w.status IN ('queued', 'running')
         ) ORDER BY q.created_at LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`).run(now(), row.id);
    return this.get(row.id);
  }

  /** Queued jobs whose `after` names the given job. */
  waiters(id: string): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs q WHERE q.status = 'queued' AND EXISTS (SELECT 1 FROM json_each(COALESCE(q.after, '[]')) WHERE value = ?) ORDER BY created_at`)
      .all(id) as unknown as JobRow[];
  }

  /** Queued jobs that wait on any job. */
  queuedWithAfter(): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND after IS NOT NULL ORDER BY created_at`).all() as unknown as JobRow[];
  }

  count(status: JobStatus): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE status = ?').get(status) as { n: number };
    return r.n;
  }

  idsWithStatus(status: JobStatus): string[] {
    return (this.db.prepare('SELECT id FROM jobs WHERE status = ?').all(status) as { id: string }[]).map((r) => r.id);
  }

  setCi(id: string, status: CiStatus, detail: object): void {
    this.db.prepare('UPDATE jobs SET ci_status = ?, ci = ? WHERE id = ?').run(status, JSON.stringify(detail), id);
  }

  ciPending(): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE ci_status = 'pending' ORDER BY finished_at`).all() as unknown as JobRow[];
  }

  inboxSince(repo: string): string | undefined {
    return (this.db.prepare('SELECT since FROM inbox_cursors WHERE repo = ?').get(repo) as { since: string } | undefined)?.since;
  }

  setInboxCursor(repo: string, since: string, polledAt: string | null): void {
    this.db
      .prepare('INSERT INTO inbox_cursors (repo, since, polled_at) VALUES (?, ?, ?) ON CONFLICT(repo) DO UPDATE SET since = excluded.since, polled_at = excluded.polled_at')
      .run(repo, since, polledAt);
  }

  /** Run fn in one transaction: all of its writes land, or none do. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  hasTrigger(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM triggers WHERE id = ?').get(id) !== undefined;
  }

  insertTrigger(t: NewTrigger): void {
    this.db
      .prepare(
        `INSERT INTO triggers (id, repo, number, url, login, job_id, react_path, reply_path, reply, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.repo, t.number, t.url, t.login, t.job_id, t.react_path, t.reply_path, t.reply, now());
  }

  setTriggerEyes(id: string, eyesId: number | null): void {
    this.db.prepare('UPDATE triggers SET eyes_id = ? WHERE id = ?').run(eyesId, id);
  }

  setReplied(id: string, reply: string): void {
    this.db.prepare('UPDATE triggers SET reply = ?, replied_at = ? WHERE id = ?').run(reply, now(), id);
  }

  triggerForJob(jobId: string): TriggerRow | undefined {
    return this.db.prepare('SELECT * FROM triggers WHERE job_id = ?').get(jobId) as TriggerRow | undefined;
  }

  /** The newest job that pushed to a branch. A mention on the branch's PR follows up on it. */
  lastPushed(repo: string, branch: string): JobRow | undefined {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE repo = ? COLLATE NOCASE AND branch = ? AND status = 'pushed' ORDER BY finished_at DESC LIMIT 1`)
      .get(repo, branch) as JobRow | undefined;
  }

  /** Triggers whose reply hasn't been posted. */
  unanswered(): TriggerRow[] {
    return this.db.prepare('SELECT * FROM triggers WHERE replied_at IS NULL ORDER BY created_at').all() as unknown as TriggerRow[];
  }

  finish(id: string, status: JobStatus, exitCode: number | null, result: string | null, error: string | null): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, finished_at = ?, exit_code = ?, result = ?, error = ? WHERE id = ?`)
      .run(status, now(), exitCode, result, error, id);
  }
}

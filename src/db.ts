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
  /** The job whose failing CI this job was submitted to fix. */
  parent_id: string | null;
  /** Follow-up jobs this job may start when its CI fails. */
  ci_fix: number | null;
  ci_status: CiStatus | null;
  /** JSON: the commit, the checks, the follow-up job, and a note. */
  ci: string | null;
}

export type NewJob = Pick<JobRow, 'id' | 'repo' | 'task' | 'runner' | 'model' | 'base_branch' | 'branch' | 'cpus' | 'memory' | 'parent_id' | 'ci_fix'>;

/** Columns added after M4; an older database gets them on open. */
const ADDED_COLUMNS: Record<string, string> = { parent_id: 'TEXT', ci_fix: 'INTEGER', ci_status: 'TEXT', ci: 'TEXT' };

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
    `);
    const have = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
    }
  }

  insert(j: NewJob): JobRow {
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo, task, runner, model, base_branch, branch, cpus, memory, parent_id, ci_fix, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(j.id, j.repo, j.task, j.runner, j.model, j.base_branch, j.branch, j.cpus, j.memory, j.parent_id, j.ci_fix, now());
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
   * Move the oldest queued job to running, skipping jobs whose branch a running job holds: two pushes to one branch
   * at once fail the second as a non-fast-forward. Single-process, synchronous, so this is atomic.
   */
  claimNext(): JobRow | undefined {
    const row = this.db
      .prepare(
        `SELECT q.id FROM jobs q WHERE q.status = 'queued' AND NOT EXISTS (
           SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.repo = q.repo COLLATE NOCASE AND r.branch = q.branch
         ) ORDER BY q.created_at LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!row) return undefined;
    this.db.prepare(`UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?`).run(now(), row.id);
    return this.get(row.id);
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

  finish(id: string, status: JobStatus, exitCode: number | null, result: string | null, error: string | null): void {
    this.db
      .prepare(`UPDATE jobs SET status = ?, finished_at = ?, exit_code = ?, result = ?, error = ? WHERE id = ?`)
      .run(status, now(), exitCode, result, error, id);
  }
}

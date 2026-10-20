import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { CredentialSource } from './credentials.ts';
import { DEFAULT_AFTER_STATUS, TERMINAL, type Db, type JobRow, type JobStatus } from './db.ts';
import { jobVolumes, removeVolume, type Disks } from './disks.ts';
import { JobProcess, removeVm, type RunOutcome } from './runner.ts';

export interface SubmitInput {
  repo: string;
  task: string;
  runner: string;
  model?: string | undefined;
  base_branch: string;
  branch?: string | undefined;
  cpus?: number | undefined;
  memory?: string | undefined;
  /** Follow-up jobs allowed if this job's CI fails. Default: EUMAEUS_CI_FIX. */
  ci_fix?: number | undefined;
  /** Set by the CI watcher on the follow-up jobs it submits, and by the inbox on a PR an eumaeus job pushed. */
  parent_id?: string | undefined;
  /** Set by the inbox: `Closes #<n>` for a job from an issue. */
  pr_footer?: string | undefined;
  /** `replace`: the job rewrites the open PR's title and body from the /work/pr.md it writes, with no commit needed. */
  pr_body?: 'replace' | undefined;
  /** Job ids this job waits for, on any repo or branch. Each must exist, or submit throws. */
  after?: string | string[] | undefined;
  /** Statuses of the named jobs that let this one start. Default: pushed or no_changes. */
  after_status?: JobStatus[] | undefined;
}

export const AFTER_MAX = 20;

export class Scheduler {
  private readonly active = new Map<string, JobProcess>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Jobs stopped by cancel, timeout, or shutdown. Their disks are never promoted. */
  private readonly killed = new Set<string>();

  private readonly db: Db;
  private readonly cfg: Config;
  private readonly creds: CredentialSource;
  readonly disks: Disks;

  constructor(db: Db, cfg: Config, creds: CredentialSource, disks: Disks) {
    this.db = db;
    this.cfg = cfg;
    this.creds = creds;
    this.disks = disks;
  }

  logPath(id: string): string { return join(this.cfg.dataDir, 'logs', `${id}.log`); }
  private envPath(id: string): string { return join(this.cfg.dataDir, 'env', `${id}.env`); }
  private outDir(id: string): string { return join(this.cfg.dataDir, 'out', id); }
  /** While this file exists, queued jobs stay queued. scripts/update.sh creates it to drain before a restart. */
  get pauseFile(): string { return join(this.cfg.dataDir, 'paused'); }

  activeCount(): number { return this.active.size; }
  paused(): boolean { return existsSync(this.pauseFile); }

  /** Queues the job. Throws when `after` names more than AFTER_MAX jobs or one that doesn't exist; nothing is queued then. */
  submit(input: SubmitInput): JobRow {
    const after = input.after === undefined ? [] : typeof input.after === 'string' ? [input.after] : input.after;
    if (after.length > AFTER_MAX) throw new Error(`after: at most ${AFTER_MAX} jobs`);
    for (const dep of after) if (!this.db.get(dep)) throw new Error(`after: no job ${dep}`);
    const id = newJobId();
    const row = this.db.insert({
      id,
      repo: input.repo,
      task: input.task,
      runner: input.runner,
      model: input.model ?? null,
      base_branch: input.base_branch,
      branch: input.branch ?? `job/${id}`,
      cpus: input.cpus ?? this.cfg.cpus,
      memory: input.memory ?? this.cfg.memory,
      parent_id: input.parent_id ?? null,
      ci_fix: input.ci_fix ?? this.cfg.ciFix,
      pr_footer: input.pr_footer ?? null,
      pr_body: input.pr_body ?? null,
      after: after.length ? JSON.stringify(after) : null,
      after_status: after.length ? JSON.stringify(input.after_status ?? DEFAULT_AFTER_STATUS) : null,
    });
    // A job chained behind one that already ended badly ends now, not when a slot frees.
    this.checkWaiter(row);
    queueMicrotask(() => this.pump());
    return this.db.get(id) ?? row;
  }

  /**
   * Every terminal write goes through here, so a job's end reaches the jobs waiting on it: a waiter whose
   * after_status doesn't include this status ends cancelled, and its own waiters follow. No VM boots for any of them.
   */
  private finish(id: string, status: JobStatus, exitCode: number | null, result: string | null, error: string | null): void {
    this.db.finish(id, status, exitCode, result, error);
    for (const w of this.db.waiters(id)) this.checkWaiter(w);
  }

  /** Cancel a queued waiter when a job it names has ended outside its after_status. Returns true when it did. */
  private checkWaiter(w: JobRow): boolean {
    if (w.status !== 'queued' || !w.after) return false;
    const allowed = new Set<string>(JSON.parse(w.after_status ?? '[]') as string[]);
    for (const dep of JSON.parse(w.after) as string[]) {
      const d = this.db.get(dep);
      if (!d || !TERMINAL.has(d.status) || allowed.has(d.status)) continue;
      const why = `after ${dep} ended ${d.status}`;
      this.finish(w.id, 'cancelled', null, null, why);
      try {
        appendFileSync(this.logPath(w.id), `[dispatcher] ${new Date().toISOString()} cancelled: ${why}; no VM started\n`);
      } catch { /* the log is best effort */ }
      return true;
    }
    return false;
  }

  /** Start queued jobs until the concurrency limit is reached. */
  pump(): void {
    if (this.paused()) return;
    while (this.active.size < this.cfg.maxConcurrent) {
      const job = this.db.claimNext();
      if (!job) return;
      void this.launch(job);
    }
  }

  private async launch(job: JobRow): Promise<void> {
    const proc = new JobProcess(job, this.cfg, this.creds, this.disks, this.logPath(job.id), this.envPath(job.id), this.outDir(job.id));
    this.active.set(job.id, proc);
    this.timers.set(job.id, setTimeout(() => {
      this.killed.add(job.id);
      this.finish(job.id, 'failed', null, null, `timeout after ${this.cfg.jobTimeoutMs / 60_000} min`);
      void proc.cancel();
    }, this.cfg.jobTimeoutMs));

    const out = await proc.run().catch((e: unknown): RunOutcome =>
      ({ exitCode: null, signal: null, result: { status: 'failed', error: `dispatcher error: ${e instanceof Error ? e.message : String(e)}` } }));
    clearTimeout(this.timers.get(job.id));
    this.timers.delete(job.id);
    // The VM must be gone before its volume is cloned or removed. The disk is settled before the job reads as
    // finished, so a job submitted the moment this one finishes clones the promoted disk.
    await removeVm(job.id);
    const promoted = await this.settleDisk(job, proc, out);
    if (out.result && proc.disk) {
      const env = out.result['env'];
      out.result['env'] = {
        ...(typeof env === 'object' && env !== null ? env : {}),
        disk: proc.disk.volume !== null ? proc.disk.source : 'none',
        promoted,
        ...(proc.image ? { image: proc.image } : {}),
      };
    }
    const current = this.db.get(job.id);
    // cancel() and the timeout write their own terminal status first; don't overwrite it.
    if (current && !TERMINAL.has(current.status)) {
      this.finish(job.id, statusFor(out), out.exitCode, out.result ? JSON.stringify(out.result) : null, errorFor(out));
      const sha = out.result?.['commit'];
      if (statusFor(out) === 'pushed' && typeof sha === 'string') {
        // src/ci.ts picks it up from the database, so a restart keeps watching.
        this.db.setCi(job.id, 'pending', { sha, since: new Date().toISOString() });
        appendFileSync(this.logPath(job.id), `[ci] ${new Date().toISOString()} watching checks on ${sha.slice(0, 8)}\n`);
      }
    }
    this.killed.delete(job.id);
    this.active.delete(job.id);
    this.pump();
  }

  /** Promote the job's disk when its setup worked and nothing killed it; always remove the volume. Never throws. */
  private async settleDisk(job: JobRow, proc: JobProcess, out: RunOutcome): Promise<boolean> {
    const volume = proc.disk?.volume;
    if (!volume) return false;
    let promoted = false;
    let note: string;
    if (this.killed.has(job.id)) note = 'discarded: the job was cancelled, timed out, or shut down';
    else if (out.result?.['setup_ok'] !== true) note = 'discarded: setup did not finish';
    else {
      try {
        await this.disks.promote(volume, job.repo);
        promoted = true;
        note = `promoted to ${this.disks.golden(job.repo)}`;
      } catch (e) {
        note = `promote failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    await removeVolume(volume);
    try {
      appendFileSync(this.logPath(job.id), `[dispatcher] ${new Date().toISOString()} disk ${note}\n`);
    } catch { /* the log is best effort */ }
    return promoted;
  }

  async cancel(id: string): Promise<JobRow | undefined> {
    const job = this.db.get(id);
    if (!job) return undefined;
    if (job.status === 'queued') {
      this.finish(id, 'cancelled', null, null, 'cancelled while queued');
      // A waiter that accepts `cancelled` may be ready now.
      queueMicrotask(() => this.pump());
    } else if (job.status === 'running') {
      this.killed.add(id);
      this.finish(id, 'cancelled', null, null, 'cancelled by user');
      await this.active.get(id)?.cancel();
    }
    return this.db.get(id);
  }

  /**
   * Jobs left 'running' by a previous process are dead. Record that and remove their VMs and volumes. Then check
   * every waiting job, in case the process died between a job's end and the cascade to its waiters.
   */
  async recover(): Promise<number> {
    const ids = this.db.idsWithStatus('running');
    for (const id of ids) {
      this.finish(id, 'failed', null, null, 'dispatcher restarted while job was running');
      await removeVm(id);
    }
    for (const w of this.db.queuedWithAfter()) this.checkWaiter(w);
    // No job is active yet, so every job volume belongs to a dead job.
    for (const v of await jobVolumes()) await removeVolume(v);
    return ids.length;
  }

  async shutdown(): Promise<void> {
    for (const [id, proc] of this.active) {
      this.killed.add(id);
      this.finish(id, 'failed', null, null, 'dispatcher shut down');
      await proc.cancel();
    }
  }

  logs(id: string, tail: number): string {
    const p = this.logPath(id);
    if (!existsSync(p)) return '';
    const lines = readFileSync(p, 'utf8').split('\n');
    return lines.slice(Math.max(0, lines.length - tail - 1)).join('\n');
  }

  /** The agent's whole last message, which job.sh writes to report.md; null before the agent has ended, and for shell. */
  report(id: string): string | null {
    const p = join(this.outDir(id), 'report.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /** Last `tail` lines of the agent's own output (runner.jsonl, runner.json, or runner.txt), optionally filtered. */
  transcript(id: string, tail: number, grep: string | undefined): string | null {
    const dir = this.outDir(id);
    const name = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith('runner.')) : undefined;
    if (!name) return null;
    let lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((l) => l !== '');
    if (grep) lines = lines.filter((l) => l.includes(grep));
    const cut = (l: string): string => (l.length > TRANSCRIPT_LINE_MAX ? `${l.slice(0, TRANSCRIPT_LINE_MAX)}… [${l.length - TRANSCRIPT_LINE_MAX} more chars]` : l);
    return `${name}: ${lines.length} line(s)${grep ? ` containing ${JSON.stringify(grep)}` : ''}\n${lines.slice(-tail).map(cut).join('\n')}`;
  }
}

const TRANSCRIPT_LINE_MAX = 4_000;

function statusFor(out: RunOutcome): JobStatus {
  const s = out.result?.['status'];
  if (s === 'pushed' || s === 'no_changes' || s === 'failed') return s;
  return 'failed';
}

function errorFor(out: RunOutcome): string | null {
  const e = out.result?.['error'];
  if (typeof e === 'string') return e;
  if (out.exitCode === 0) return null;
  return out.signal ? `killed by ${out.signal}` : `exit ${out.exitCode ?? 'unknown'}`;
}

function newJobId(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { CredentialSource } from './credentials.ts';
import { TERMINAL, type Db, type JobRow, type JobStatus } from './db.ts';
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
}

export class Scheduler {
  private readonly active = new Map<string, JobProcess>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  private readonly db: Db;
  private readonly cfg: Config;
  private readonly creds: CredentialSource;

  constructor(db: Db, cfg: Config, creds: CredentialSource) {
    this.db = db;
    this.cfg = cfg;
    this.creds = creds;
  }

  logPath(id: string): string { return join(this.cfg.dataDir, 'logs', `${id}.log`); }
  private envPath(id: string): string { return join(this.cfg.dataDir, 'env', `${id}.env`); }

  activeCount(): number { return this.active.size; }

  submit(input: SubmitInput): JobRow {
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
    });
    queueMicrotask(() => this.pump());
    return row;
  }

  /** Start queued jobs until the concurrency limit is reached. */
  pump(): void {
    while (this.active.size < this.cfg.maxConcurrent) {
      const job = this.db.claimNext();
      if (!job) return;
      void this.launch(job);
    }
  }

  private async launch(job: JobRow): Promise<void> {
    const proc = new JobProcess(job, this.cfg, this.creds, this.logPath(job.id), this.envPath(job.id));
    this.active.set(job.id, proc);
    this.timers.set(job.id, setTimeout(() => {
      this.db.finish(job.id, 'failed', null, null, `timeout after ${this.cfg.jobTimeoutMs / 60_000} min`);
      void proc.cancel();
    }, this.cfg.jobTimeoutMs));

    try {
      const out = await proc.run();
      const current = this.db.get(job.id);
      // cancel() and the timeout write their own terminal status first; don't overwrite it.
      if (current && !TERMINAL.has(current.status)) {
        this.db.finish(job.id, statusFor(out), out.exitCode, out.result ? JSON.stringify(out.result) : null, errorFor(out));
      }
    } finally {
      clearTimeout(this.timers.get(job.id));
      this.timers.delete(job.id);
      this.active.delete(job.id);
      await removeVm(job.id);
      this.pump();
    }
  }

  async cancel(id: string): Promise<JobRow | undefined> {
    const job = this.db.get(id);
    if (!job) return undefined;
    if (job.status === 'queued') {
      this.db.finish(id, 'cancelled', null, null, 'cancelled while queued');
    } else if (job.status === 'running') {
      this.db.finish(id, 'cancelled', null, null, 'cancelled by user');
      await this.active.get(id)?.cancel();
    }
    return this.db.get(id);
  }

  /** Jobs left 'running' by a previous process are dead. Record that and remove their VMs. */
  async recover(): Promise<number> {
    const ids = this.db.idsWithStatus('running');
    for (const id of ids) {
      this.db.finish(id, 'failed', null, null, 'dispatcher restarted while job was running');
      await removeVm(id);
    }
    return ids.length;
  }

  async shutdown(): Promise<void> {
    for (const [id, proc] of this.active) {
      this.db.finish(id, 'failed', null, null, 'dispatcher shut down');
      await proc.cancel();
    }
  }

  logs(id: string, tail: number): string {
    const p = this.logPath(id);
    if (!existsSync(p)) return '';
    const lines = readFileSync(p, 'utf8').split('\n');
    return lines.slice(Math.max(0, lines.length - tail - 1)).join('\n');
  }
}

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

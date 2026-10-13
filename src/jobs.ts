import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import type { CredentialSource } from './credentials.ts';
import { TERMINAL, type Db, type JobRow, type JobStatus } from './db.ts';
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
}

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
      this.db.finish(job.id, 'failed', null, null, `timeout after ${this.cfg.jobTimeoutMs / 60_000} min`);
      void proc.cancel();
    }, this.cfg.jobTimeoutMs));

    const out = await proc.run().catch((e: unknown): RunOutcome =>
      ({ exitCode: null, signal: null, result: { status: 'failed', error: `dispatcher error: ${e instanceof Error ? e.message : String(e)}` } }));
    clearTimeout(this.timers.get(job.id));
    this.timers.delete(job.id);
    // The VM must be gone before its volume is cloned or removed. The disk is settled before the job reads as
    // finished, so a job submitted the moment this one finishes clones the promoted disk.
    await removeVm(job.id);
    await this.settleDisk(job, proc, out);
    const current = this.db.get(job.id);
    // cancel() and the timeout write their own terminal status first; don't overwrite it.
    if (current && !TERMINAL.has(current.status)) {
      this.db.finish(job.id, statusFor(out), out.exitCode, out.result ? JSON.stringify(out.result) : null, errorFor(out));
    }
    this.killed.delete(job.id);
    this.active.delete(job.id);
    this.pump();
  }

  /** Promote the job's disk when its setup worked and nothing killed it; always remove the volume. Never throws. */
  private async settleDisk(job: JobRow, proc: JobProcess, out: RunOutcome): Promise<void> {
    const volume = proc.disk?.volume;
    if (!volume) return;
    let note: string;
    if (this.killed.has(job.id)) note = 'discarded: the job was cancelled, timed out, or shut down';
    else if (out.result?.['setup_ok'] !== true) note = 'discarded: setup did not finish';
    else {
      try {
        await this.disks.promote(volume, job.repo);
        note = `promoted to ${this.disks.golden(job.repo)}`;
      } catch (e) {
        note = `promote failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    await removeVolume(volume);
    try {
      appendFileSync(this.logPath(job.id), `[dispatcher] ${new Date().toISOString()} disk ${note}\n`);
    } catch { /* the log is best effort */ }
  }

  async cancel(id: string): Promise<JobRow | undefined> {
    const job = this.db.get(id);
    if (!job) return undefined;
    if (job.status === 'queued') {
      this.db.finish(id, 'cancelled', null, null, 'cancelled while queued');
    } else if (job.status === 'running') {
      this.killed.add(id);
      this.db.finish(id, 'cancelled', null, null, 'cancelled by user');
      await this.active.get(id)?.cancel();
    }
    return this.db.get(id);
  }

  /** Jobs left 'running' by a previous process are dead. Record that and remove their VMs and volumes. */
  async recover(): Promise<number> {
    const ids = this.db.idsWithStatus('running');
    for (const id of ids) {
      this.db.finish(id, 'failed', null, null, 'dispatcher restarted while job was running');
      await removeVm(id);
    }
    // No job is active yet, so every job volume belongs to a dead job.
    for (const v of await jobVolumes()) await removeVolume(v);
    return ids.length;
  }

  async shutdown(): Promise<void> {
    for (const [id, proc] of this.active) {
      this.killed.add(id);
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

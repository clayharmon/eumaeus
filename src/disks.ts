import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.ts';

const run = promisify(execFile);

/** The tool profile scripts/disk.ts builds into the template; the job image puts its bin/ on PATH. */
export const TOOL_PROFILE = '/nix/var/nix/profiles/eumaeus';
/** Pinned so every template is built the same way. */
export const NIX_VERSION = '2.35.3';

export type DiskSource = 'golden' | 'template';
export type PreparedDisk = { volume: string; source: DiskSource; notes: string[] } | { volume: null; reason: string; notes: string[] };

/** A repo's golden disk on the host. `bytes` is what the sparse file holds; blocks shared with clones count in full. */
export interface GoldenDisk { repo: string; path: string; bytes: number; used: Date }

const GB = 2 ** 30;
const gb = (n: number): string => `${(n / GB).toFixed(1)} GB`;

/**
 * Per-repo disks (docs/m5-environments.md). A disk is an ext4 image file that `container` attaches as a volume.
 * Each job boots on an APFS clone of its repo's golden disk, or of the template when the repo has none yet;
 * promote() makes a finished job's disk the new golden one. No disk is ever attached to two VMs.
 */
export class Disks {
  private readonly cfg: Config;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  get dir(): string { return join(this.cfg.dataDir, 'disks'); }
  get template(): string { return join(this.dir, 'template.img'); }
  golden(repo: string): string { return join(this.dir, `${repo.replace('/', '__')}.img`); }

  /**
   * Create volume eumaeus-<job id> and clone the repo's golden disk, or the template, over its image file. First the
   * size rules run: a disk over EUMAEUS_DISK_MAX_GB is reset, and while the Mac has less than EUMAEUS_DISK_FREE_GB
   * free the biggest disks are reset. `notes` says what they deleted.
   */
  async prepare(jobId: string, repo: string): Promise<PreparedDisk> {
    const notes = this.enforce(repo);
    const golden = this.golden(repo);
    const source: DiskSource | null = existsSync(golden) ? 'golden' : existsSync(this.template) ? 'template' : null;
    if (!source) return { volume: null, reason: `no template at ${this.template}; run node scripts/disk.ts template`, notes };
    // The modification time is the last job's start, which the idle sweep reads.
    if (source === 'golden') utimesSync(golden, new Date(), new Date());
    const volume = jobVolume(jobId);
    try {
      await run('container', ['volume', 'create', '-s', this.cfg.diskSize, volume]);
      const target = await volumeSource(volume);
      if (!target) throw new Error(`container volume inspect ${volume} has no configuration.source`);
      await clone(source === 'golden' ? golden : this.template, target);
      return { volume, source, notes };
    } catch (e) {
      await removeVolume(volume);
      return { volume: null, reason: e instanceof Error ? e.message : String(e), notes };
    }
  }

  /** Every golden disk, biggest first. The template is not one. */
  list(): GoldenDisk[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.img') && f !== 'template.img')
      .map((f) => {
        const path = join(this.dir, f);
        const st = statSync(path);
        return { repo: f.slice(0, -4).replace('__', '/'), path, bytes: st.blocks * 512, used: st.mtime };
      })
      .sort((a, b) => b.bytes - a.bytes);
  }

  /** Bytes free on the volume that holds the disks. */
  freeBytes(): number {
    const st = statfsSync(existsSync(this.dir) ? this.dir : this.cfg.dataDir);
    return st.bavail * st.bsize;
  }

  /** The size rules, before a job on `repo` clones. Returns one note per deleted disk. */
  enforce(repo: string): string[] {
    const notes: string[] = [];
    const own = this.list().find((d) => d.repo === repo);
    if (own && this.cfg.diskMaxBytes > 0 && own.bytes > this.cfg.diskMaxBytes) {
      rmSync(own.path, { force: true });
      notes.push(`reset ${repo}: ${gb(own.bytes)}, over the ${gb(this.cfg.diskMaxBytes)} cap`);
    }
    if (this.cfg.diskFreeBytes > 0) {
      for (const d of this.list()) {
        const free = this.freeBytes();
        if (free >= this.cfg.diskFreeBytes) break;
        rmSync(d.path, { force: true });
        notes.push(`reset ${d.repo}: ${gb(d.bytes)}, the biggest disk, with ${gb(free)} free on the Mac (floor ${gb(this.cfg.diskFreeBytes)})`);
      }
    }
    return notes;
  }

  /** Delete disks no job has started on for EUMAEUS_DISK_IDLE_DAYS. The dispatcher runs this daily. */
  sweepIdle(): string[] {
    if (this.cfg.diskIdleMs <= 0) return [];
    const cutoff = Date.now() - this.cfg.diskIdleMs;
    return this.list()
      .filter((d) => d.used.getTime() < cutoff)
      .map((d) => {
        rmSync(d.path, { force: true });
        return `deleted ${d.repo}: ${gb(d.bytes)}, last job ${d.used.toISOString().slice(0, 10)}`;
      });
  }

  /** Make the job's disk the repo's golden disk. The rename is atomic, so a job starting now clones old or new. */
  async promote(volume: string, repo: string): Promise<void> {
    const src = await volumeSource(volume);
    if (!src) throw new Error(`container volume inspect ${volume} has no configuration.source`);
    mkdirSync(this.dir, { recursive: true });
    const golden = this.golden(repo);
    const tmp = `${golden}.${volume}.tmp`;
    await clone(src, tmp);
    renameSync(tmp, golden);
  }

  /** Delete the repo's golden disk; its next job starts from the template. False when there was none. */
  reset(repo: string): boolean {
    const golden = this.golden(repo);
    if (!existsSync(golden)) return false;
    rmSync(golden);
    return true;
  }
}

export function jobVolume(jobId: string): string {
  return `eumaeus-${jobId}`;
}

/** The image file behind a volume, from `container volume inspect`. Null when the volume or the field is missing. */
export async function volumeSource(volume: string): Promise<string | null> {
  try {
    const { stdout } = await run('container', ['volume', 'inspect', volume]);
    const parsed = JSON.parse(stdout) as { configuration?: { source?: string } }[];
    return parsed[0]?.configuration?.source ?? null;
  } catch {
    return null;
  }
}

export async function removeVolume(volume: string): Promise<void> {
  await run('container', ['volume', 'rm', volume]).catch(() => undefined);
}

/** Job volumes left by a previous dispatcher process. */
export async function jobVolumes(): Promise<string[]> {
  try {
    const { stdout } = await run('container', ['volume', 'list', '--quiet']);
    return stdout.split('\n').map((s) => s.trim()).filter((s) => /^eumaeus-\d{8}-\d{6}-[0-9a-f]{4}$/.test(s));
  } catch {
    return [];
  }
}

/** APFS clone: 3 ms and no extra space for a 3.2 GB disk. Node's COPYFILE_FICLONE_FORCE is ENOSYS on macOS. */
async function clone(src: string, dst: string): Promise<void> {
  rmSync(dst, { force: true });
  await run('cp', ['-c', src, dst]);
}

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.ts';
import type { CredentialSource, GitIdentity } from './credentials.ts';
import type { JobRow } from './db.ts';
import type { Disks, PreparedDisk } from './disks.ts';
import { envArgs, readEnvToml, readRepoFile, type EnvToml } from './envfile.ts';
import { repoImage } from './images.ts';

export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last JSON line job.sh printed on stdout, if any. */
  result: Record<string, unknown> | null;
}

export function vmName(jobId: string): string {
  return `eumaeus-${jobId}`;
}

/** Fire-and-forget `container <args>`; never throws. */
export function containerCmd(args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn('container', args, { stdio: 'ignore' });
    p.on('close', (code) => resolve(code));
    p.on('error', () => resolve(null));
  });
}

export async function removeVm(jobId: string): Promise<void> {
  await containerCmd(['rm', '-f', vmName(jobId)]);
}

/**
 * One job VM. Secrets go in a 0600 env file that exists only while the job runs,
 * so they never appear in `ps`. The task text does go on argv; it is not secret.
 */
export class JobProcess {
  readonly name: string;
  /** Set by run(): the volume mounted at /nix, or why there is none. */
  disk: PreparedDisk | null = null;
  /** Set by run() when .eumaeus.toml names a Dockerfile: the repo image the VM boots. */
  image: string | null = null;
  private child: ChildProcess | null = null;
  private readonly job: JobRow;
  private readonly cfg: Config;
  private readonly logPath: string;
  private readonly envPath: string;
  private readonly outDir: string;
  private readonly creds: CredentialSource;
  private readonly disks: Disks;

  constructor(job: JobRow, cfg: Config, creds: CredentialSource, disks: Disks, logPath: string, envPath: string, outDir: string) {
    this.job = job;
    this.cfg = cfg;
    this.creds = creds;
    this.disks = disks;
    this.logPath = logPath;
    this.envPath = envPath;
    this.outDir = outDir;
    this.name = vmName(job.id);
  }

  async run(): Promise<RunOutcome> {
    const j = this.job;
    mkdirSync(dirname(this.logPath), { recursive: true });
    mkdirSync(this.outDir, { recursive: true, mode: 0o700 });
    const log = createWriteStream(this.logPath, { flags: 'a' });
    log.write(`[dispatcher] ${new Date().toISOString()} start ${this.name} repo=${j.repo} runner=${j.runner} cpus=${j.cpus} mem=${j.memory}\n`);

    let token: string;
    try {
      const id = await this.writeEnvFile();
      token = id.token;
      log.write(`[dispatcher] credentials: ${id.source} as ${id.name}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.write(`[dispatcher] credential error: ${msg}\n`);
      log.end();
      return { exitCode: null, signal: null, result: { status: 'failed', error: msg } };
    }
    // A job on its own new branch reads the base; one continuing a branch reads that branch, then the base.
    const refs = j.branch === `job/${j.id}` ? [j.base_branch] : [j.branch, j.base_branch];
    let toml: EnvToml | null = null;
    let image = this.cfg.image;
    try {
      const found = await readEnvToml(j.repo, refs, token);
      toml = found?.toml ?? null;
      log.write(`[dispatcher] .eumaeus.toml: ${toml ? JSON.stringify(toml) : 'none'}\n`);
      if (found && toml?.image) {
        const dockerfile = await readRepoFile(j.repo, found.ref, toml.image, token);
        if (dockerfile === null) throw new Error(`.eumaeus.toml image: ${toml.image} not found at ${found.ref}`);
        image = await repoImage(this.cfg, j.repo, dockerfile, (s) => log.write(`[dispatcher] ${s}\n`));
        this.image = image;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.write(`[dispatcher] ${msg}\n`);
      log.end();
      rmSync(this.envPath, { force: true });
      return { exitCode: null, signal: null, result: { status: 'failed', error: msg } };
    }
    const disk = await this.disks.prepare(j.id, j.repo);
    this.disk = disk;
    for (const n of disk.notes) log.write(`[dispatcher] disk: ${n}\n`);
    log.write(disk.volume !== null
      ? `[dispatcher] disk: ${disk.source} clone as volume ${disk.volume}\n`
      : `[dispatcher] disk: none (${disk.reason})\n`);
    const args = [
      'run', '--rm', '--progress', 'none', '--name', this.name,
      '--cpus', String(j.cpus), '--memory', j.memory,
      '-e', `JOB_ID=${j.id}`, '-e', `REPO=${j.repo}`, '-e', `TASK=${j.task}`,
      '-e', `RUNNER=${j.runner}`, '-e', `MODEL=${j.model ?? ''}`,
      '-e', `BASE_BRANCH=${j.base_branch}`, '-e', `BRANCH=${j.branch}`,
      '-e', `OPEN_PR=${this.cfg.openPr ? '1' : '0'}`, '-e', `PR_ASSIGNEE=${this.cfg.prAssignee}`,
      ...envArgs(toml),
      '--env-file', this.envPath,
      // Bind mount: the agent's transcript lands here and outlives the VM.
      '-v', `${this.outDir}:/out`,
      ...(disk.volume !== null ? ['-v', `${disk.volume}:/nix`] : []),
      image,
    ];
    return this.spawnVm(args, log);
  }

  private spawnVm(args: string[], log: WriteStream): Promise<RunOutcome> {
    const child = spawn('container', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); log.write(d); });
    child.stderr?.on('data', (d: Buffer) => log.write(d));

    return new Promise((resolve) => {
      const done = (out: RunOutcome, note: string): void => {
        log.write(`[dispatcher] ${new Date().toISOString()} ${note}\n`);
        log.end();
        this.child = null;
        rmSync(this.envPath, { force: true });
        resolve(out);
      };
      child.on('close', (code, signal) =>
        done({ exitCode: code, signal, result: lastJsonLine(stdout) }, `exit code=${code} signal=${signal ?? 'none'}`));
      child.on('error', (err) => done({ exitCode: null, signal: null, result: null }, `spawn error: ${err.message}`));
    });
  }

  /** Stop the VM; the `container run` child then exits and `run()` settles. */
  async cancel(): Promise<void> {
    await containerCmd(['stop', '-t', '5', this.name]);
    await containerCmd(['rm', '-f', this.name]);
    this.child?.kill('SIGTERM');
  }

  /** Agent secrets plus a git identity for this one repo. Returns the identity; its token also reads .eumaeus.toml. */
  private async writeEnvFile(): Promise<GitIdentity> {
    mkdirSync(dirname(this.envPath), { recursive: true, mode: 0o700 });
    const secrets = existsSync(this.cfg.secretsFile) ? readFileSync(this.cfg.secretsFile, 'utf8').trimEnd() + '\n' : '';
    const id = await this.creds.identityFor(this.job.repo);
    const lines = [`GH_TOKEN=${id.token}`, `GIT_AUTHOR_NAME=${id.name}`, `GIT_AUTHOR_EMAIL=${id.email}`];
    writeFileSync(this.envPath, `${secrets}${lines.join('\n')}\n`, { mode: 0o600 });
    return id;
  }
}

function lastJsonLine(s: string): Record<string, unknown> | null {
  for (const line of s.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* keep looking */ }
  }
  return null;
}

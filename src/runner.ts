import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from './config.ts';
import type { JobRow } from './db.ts';

export interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last JSON line job.sh printed on stdout, if any. */
  result: Record<string, unknown> | null;
}

export function ghToken(user: string): string {
  return execFileSync('gh', ['auth', 'token', '-u', user], { encoding: 'utf8' }).trim();
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
  private child: ChildProcess | null = null;
  private readonly job: JobRow;
  private readonly cfg: Config;
  private readonly logPath: string;
  private readonly envPath: string;

  constructor(job: JobRow, cfg: Config, logPath: string, envPath: string) {
    this.job = job;
    this.cfg = cfg;
    this.logPath = logPath;
    this.envPath = envPath;
    this.name = vmName(job.id);
  }

  run(): Promise<RunOutcome> {
    this.writeEnvFile();
    const j = this.job;
    const args = [
      'run', '--rm', '--progress', 'none', '--name', this.name,
      '--cpus', String(j.cpus), '--memory', j.memory,
      '-e', `JOB_ID=${j.id}`, '-e', `REPO=${j.repo}`, '-e', `TASK=${j.task}`,
      '-e', `RUNNER=${j.runner}`, '-e', `MODEL=${j.model ?? ''}`,
      '-e', `BASE_BRANCH=${j.base_branch}`, '-e', `BRANCH=${j.branch}`,
      '--env-file', this.envPath,
      this.cfg.image,
    ];

    mkdirSync(dirname(this.logPath), { recursive: true });
    const log = createWriteStream(this.logPath, { flags: 'a' });
    log.write(`[dispatcher] ${new Date().toISOString()} start ${this.name} repo=${j.repo} runner=${j.runner} cpus=${j.cpus} mem=${j.memory}\n`);

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

  private writeEnvFile(): void {
    mkdirSync(dirname(this.envPath), { recursive: true, mode: 0o700 });
    const secrets = existsSync(this.cfg.secretsFile) ? readFileSync(this.cfg.secretsFile, 'utf8').trimEnd() + '\n' : '';
    writeFileSync(this.envPath, `${secrets}GH_TOKEN=${ghToken(this.cfg.ghUser)}\n`, { mode: 0o600 });
  }
}

function lastJsonLine(s: string): Record<string, unknown> | null {
  for (const line of s.trim().split('\n').reverse()) {
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line) as Record<string, unknown>; } catch { /* keep looking */ }
  }
  return null;
}

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, memoryMb } from './config.ts';
import { pickCredentials } from './credentials.ts';
import { CiWatcher } from './ci.ts';
import { Db } from './db.ts';
import { Disks } from './disks.ts';
import { GitHubApp, loadGitHubApp } from './github.ts';
import { startHttp } from './http.ts';
import { Inbox } from './inbox.ts';
import { Scheduler } from './jobs.ts';
import { dispatcherCommit, imageCommit } from './version.ts';

const log = (s: string): void => console.error(`[eumaeus] ${new Date().toISOString()} ${s}`);

// A default job size over the budget could never start, so stop here with both numbers rather than queue forever.
if (config.memoryBudget && memoryMb(config.memory) > memoryMb(config.memoryBudget)) {
  log(`EUMAEUS_MEMORY ${config.memory} is over EUMAEUS_MEMORY_BUDGET ${config.memoryBudget}; set one under the other`);
  process.exit(1);
}

mkdirSync(join(config.dataDir, 'logs'), { recursive: true });
const db = new Db(config.dataDir);
const appCfg = loadGitHubApp(config.githubAppFile);
const app = appCfg ? new GitHubApp(appCfg) : null;
const creds = pickCredentials(app, config.ghUser);
const disks = new Disks(config);
const sched = new Scheduler(db, config, creds, disks);
log(`git identity: ${creds.describe}`);
if (creds.describe.startsWith('gh-cli')) log(`no GitHub App at ${config.githubAppFile}; run: node scripts/github-app-setup.ts`);

const recovered = await sched.recover();
if (recovered) log(`marked ${recovered} orphaned running job(s) failed`);
log(`data=${config.dataDir} image=${config.image} max_concurrent=${config.maxConcurrent} per_job=${config.cpus}cpu/${config.memory} memory_budget=${config.memoryBudget || 'off'}`);
log(`commit=${dispatcherCommit() ?? 'unknown'} image_commit=${(await imageCommit(config.image)) ?? 'unknown'}`);
if (sched.paused()) log(`paused: queued jobs wait until ${sched.pauseFile} is removed`);
log(existsSync(disks.template) ? `disk template: ${disks.template}` : `disk template missing; jobs run with no disk until: node scripts/disk.ts template`);

const inbox = new Inbox(db, sched, app, config, log);
const http = startHttp(config, sched, db, creds, inbox, log);
sched.pump();
// Picks up queued jobs after the pause file is removed; submit and job exit pump on their own.
setInterval(() => sched.pump(), 5_000).unref();
new CiWatcher(db, sched, creds, config, log).start();
inbox.start();
const sweep = (): void => { for (const n of disks.sweepIdle()) log(`disk ${n}`); };
sweep();
setInterval(sweep, 86_400_000).unref();

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`${signal}: shutting down, ${sched.activeCount()} job(s) active`);
  http.close();
  await sched.shutdown();
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

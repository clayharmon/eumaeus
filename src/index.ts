import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { pickCredentials } from './credentials.ts';
import { Db } from './db.ts';
import { startHttp } from './http.ts';
import { Scheduler } from './jobs.ts';

const log = (s: string): void => console.error(`[eumaeus] ${new Date().toISOString()} ${s}`);

mkdirSync(join(config.dataDir, 'logs'), { recursive: true });
const db = new Db(config.dataDir);
const creds = pickCredentials(config.githubAppFile, config.ghUser);
const sched = new Scheduler(db, config, creds);
log(`git identity: ${creds.describe}`);
if (creds.describe.startsWith('gh-cli')) log(`no GitHub App at ${config.githubAppFile}; run: node scripts/github-app-setup.ts`);

const recovered = await sched.recover();
if (recovered) log(`marked ${recovered} orphaned running job(s) failed`);
log(`data=${config.dataDir} image=${config.image} max_concurrent=${config.maxConcurrent} per_job=${config.cpus}cpu/${config.memory}`);

const http = startHttp(config, sched, db, log);
sched.pump();

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

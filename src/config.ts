import { homedir } from 'node:os';
import { resolve } from 'node:path';

const env = (k: string, d: string): string => process.env[k] ?? d;
const home = (p: string): string => p.replace(/^~(?=$|\/)/, homedir());

export const config = {
  host: env('EUMAEUS_HOST', '127.0.0.1'),
  port: Number(env('EUMAEUS_PORT', '7777')),
  /** If set, /mcp requires `Authorization: Bearer <token>`. Unset = localhost dev. */
  authToken: process.env['EUMAEUS_AUTH_TOKEN'] ?? null,
  dataDir: resolve(home(env('EUMAEUS_DATA', '~/.local/share/eumaeus'))),
  image: env('EUMAEUS_IMAGE', 'eumaeus-job:dev'),
  maxConcurrent: Number(env('EUMAEUS_MAX_CONCURRENT', '2')),
  /** Agent credentials (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). Copied into each job's env file. */
  secretsFile: resolve(home(env('EUMAEUS_SECRETS', '~/.config/eumaeus/secrets.env'))),
  /** M0/M1 shortcut: GH_TOKEN comes from `gh auth token -u <user>`. M2 replaces this with a GitHub App. */
  ghUser: env('EUMAEUS_GH_USER', 'clayharmon'),
  cpus: Number(env('EUMAEUS_CPUS', '4')),
  memory: env('EUMAEUS_MEMORY', '4G'),
  jobTimeoutMs: Number(env('EUMAEUS_JOB_TIMEOUT_MIN', '60')) * 60_000,
} as const;

export type Config = typeof config;

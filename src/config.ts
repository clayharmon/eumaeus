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
  /** Written by scripts/github-app-setup.ts. When present, jobs push and open PRs as the app's bot. */
  githubAppFile: resolve(home(env('EUMAEUS_GITHUB_APP', '~/.config/eumaeus/github-app.json'))),
  /** Fallback when no GitHub App is configured: GH_TOKEN from `gh auth token -u <user>`. */
  ghUser: env('EUMAEUS_GH_USER', 'clayharmon'),
  /** Open a pull request after a successful push. */
  openPr: env('EUMAEUS_OPEN_PR', '1') !== '0',
  /** GitHub login assigned to every PR the bot opens. Empty = nobody. Defaults to EUMAEUS_GH_USER. */
  prAssignee: env('EUMAEUS_PR_ASSIGNEE', env('EUMAEUS_GH_USER', 'clayharmon')),
  cpus: Number(env('EUMAEUS_CPUS', '4')),
  memory: env('EUMAEUS_MEMORY', '4G'),
  jobTimeoutMs: Number(env('EUMAEUS_JOB_TIMEOUT_MIN', '60')) * 60_000,
} as const;

export type Config = typeof config;

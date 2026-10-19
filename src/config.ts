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
  /** Fallback when no GitHub App is configured: GH_TOKEN from `gh auth token [-u <user>]`. Empty = gh's active account. */
  ghUser: env('EUMAEUS_GH_USER', ''),
  /** Open a pull request after a successful push. */
  openPr: env('EUMAEUS_OPEN_PR', '1') !== '0',
  /** GitHub login assigned to every PR the bot opens. Empty = nobody. Defaults to EUMAEUS_GH_USER. */
  prAssignee: env('EUMAEUS_PR_ASSIGNEE', env('EUMAEUS_GH_USER', '')),
  cpus: Number(env('EUMAEUS_CPUS', '4')),
  memory: env('EUMAEUS_MEMORY', '4G'),
  jobTimeoutMs: Number(env('EUMAEUS_JOB_TIMEOUT_MIN', '60')) * 60_000,
  /** Size of each per-repo disk. The image file is sparse: it takes host space only for what jobs write. */
  diskSize: env('EUMAEUS_DISK_SIZE', '64G'),
  /** A repo's disk holding more than this on the host is reset before its next job. 0 = no cap. */
  diskMaxBytes: Number(env('EUMAEUS_DISK_MAX_GB', '40')) * 2 ** 30,
  /** While the Mac has less free than this, the biggest disks are reset before a job. 0 = no floor. */
  diskFreeBytes: Number(env('EUMAEUS_DISK_FREE_GB', '15')) * 2 ** 30,
  /** Disks no job has started on for this long are deleted, checked daily. 0 = never. */
  diskIdleMs: Number(env('EUMAEUS_DISK_IDLE_DAYS', '30')) * 86_400_000,
  /** Follow-up jobs a pushed job may start when its CI fails (src/ci.ts). 0 watches and records only. */
  ciFix: Number(env('EUMAEUS_CI_FIX', '1')),
  /** Stop watching a commit's checks after this long and record `timeout`. */
  ciTimeoutMs: Number(env('EUMAEUS_CI_TIMEOUT_MIN', '60')) * 60_000,
  /** GitHub logins whose labels and mentions start jobs (src/inbox.ts), lowercased. Empty turns the inbox off. */
  inboxUsers: env('EUMAEUS_INBOX_USERS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  inboxPollMs: Number(env('EUMAEUS_INBOX_POLL_S', '60')) * 1000,
} as const;

export type Config = typeof config;

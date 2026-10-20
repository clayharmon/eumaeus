import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CredentialSource } from './credentials.ts';
import { JOB_STATUSES, type Db, type JobRow } from './db.ts';
import type { Scheduler } from './jobs.ts';
import { mergePr } from './prs.ts';
import { RUNNERS, missingSecret } from './secrets.ts';

const text = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

/** Trim the row for tool output: the task can be long and the result is JSON-in-a-string. */
function view(j: JobRow, db: Db): Record<string, unknown> {
  const result = j.result ? (JSON.parse(j.result) as Record<string, unknown>) : null;
  const { ci_status, ci: ciDetail, ...row } = j;
  const t = db.triggerForJob(j.id);
  return {
    ...row,
    // The GitHub event that started the job (src/inbox.ts).
    trigger: t ? { kind: t.id.slice(0, t.id.indexOf(':')), url: t.url, login: t.login } : null,
    ci: ci_status ? { status: ci_status, ...(ciDetail ? (JSON.parse(ciDetail) as Record<string, unknown>) : {}) } : null,
    task: j.task.length > 300 ? `${j.task.slice(0, 300)}…` : j.task,
    result,
    url: typeof result?.['pr_url'] === 'string' ? result['pr_url'] : j.status === 'pushed' ? `https://github.com/${j.repo}/tree/${j.branch}` : null,
  };
}

/**
 * What every client's agent reads at the start of a session. Agents remember nothing between sessions, so this and
 * the tool descriptions say what the dispatcher does now; they are not a changelog.
 */
function instructions(inbox: string | null): string {
  return [
    'eumaeus runs coding agents in throwaway VMs and pushes their work to GitHub. submit_job returns at once; poll ' +
      'job_status until the status is pushed, no_changes, failed, or cancelled.',
    '- Jobs on the same repo and branch run one at a time. A later one waits, then starts from the branch\'s new head.',
    '- After a push, eumaeus watches CI and may submit a follow-up job to fix a failure (job_status ci.followup).',
    inbox
      ? `- Jobs also start from GitHub: ${inbox}. Such a job's job_status has trigger {kind, url, login}, and eumaeus posts the outcome there.`
      : '- Starting jobs from GitHub labels and mentions is off on this dispatcher.',
    '- Every VM has a headless Chromium driven by playwright-cli. Screenshots an agent saves show in the PR; ' +
      'job_status result.screenshots lists their URLs.',
  ].join('\n');
}

export function buildMcpServer(
  sched: Scheduler, db: Db, creds: CredentialSource, secretsFile: string, commit: string | null, inbox: string | null,
): McpServer {
  // The commit as semver build metadata, so a client's server list shows which build it reached.
  const server = new McpServer({ name: 'eumaeus', version: commit ? `0.1.0+${commit}` : '0.1.0' }, { instructions: instructions(inbox) });

  server.registerTool(
    'submit_job',
    {
      title: 'Submit a job',
      description:
        'Queue a coding task. A fresh VM clones <repo> at <base_branch>, runs the agent on <task>, commits, and pushes ' +
        'branch job/<id> and opens a PR. Pass branch= to continue an existing branch/PR instead (the VM checks it out ' +
        'and pushes to it). Returns at once with the job id; poll job_status. Be specific in the task: name files and ' +
        'the expected outcome. The VM has the repo\'s environment from its devenv.nix, devbox.json, .flox, flake.nix, ' +
        'mise.toml, or .eumaeus.toml (see job_status result.env), and a headless Chromium (playwright-cli); screenshots ' +
        'the agent saves show in the PR. While another job runs on the same repo and branch, this one stays queued, ' +
        "then starts from the branch's new head. Only the pushed branch, the transcript, and the repo's cached disk " +
        'outlive the VM.',
      inputSchema: {
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('GitHub repo as owner/name'),
        task: z.string().min(1).max(20_000).describe('Instructions for the agent'),
        runner: z.enum(RUNNERS).default('claude').describe(
          'claude = Claude Code; codex = OpenAI Codex CLI; antigravity = Google agy; pi = pi (any provider, give model as provider/id); shell = run task as bash (testing)'),
        model: z.string().optional().describe('Model override. claude/codex/antigravity: vendor model id. pi: provider/model or a fuzzy name like "sonnet"'),
        base_branch: z.string().default('main'),
        branch: z.string().optional().describe('Branch to push. An existing branch (e.g. a PR head) is checked out and continued; a new name is created from base_branch. Default: job/<id>'),
        cpus: z.number().int().min(1).max(8).optional(),
        memory: z.string().regex(/^\d+[MG]$/).optional().describe('e.g. 4G'),
        ci_fix: z.number().int().min(0).max(3).optional().describe(
          'Follow-up jobs eumaeus may submit, one at a time, when CI fails on what this job pushed. Default EUMAEUS_CI_FIX (1). ' +
          '0 watches CI and records the result without fixing; use it when you handle CI yourself.'),
      },
    },
    async (args) => {
      const missing = missingSecret(args.runner, secretsFile);
      if (missing) return text({ error: missing });
      return text(view(sched.submit(args), db));
    },
  );

  server.registerTool(
    'job_status',
    {
      title: 'Job status',
      description:
        'Current state of one job: its result JSON, its branch or PR URL once pushed, and `ci` once pushed: pending, success, ' +
        'failure, none (no checks), timeout, or unavailable, with each check and, after a failure, the follow-up job id. ' +
        'A pushed result has new_commits, pr_opened (true when this job opened the PR), and screenshots (image URLs, when ' +
        'the agent saved any). `trigger` is {kind, url, login} for a job started from GitHub by a label or mention ' +
        '(kind: label, issue, comment, review-comment, or review), and null otherwise.',
      inputSchema: { job_id: z.string() },
    },
    async ({ job_id }) => {
      const j = db.get(job_id);
      return text(j ? view(j, db) : { error: 'not found', job_id });
    },
  );

  server.registerTool(
    'job_logs',
    {
      title: 'Job logs',
      description: 'Tail of the job log: dispatcher lines, clone, agent summary, cost, push.',
      inputSchema: { job_id: z.string(), tail: z.number().int().min(1).max(2000).default(200) },
    },
    async ({ job_id, tail }) => text(db.get(job_id) ? sched.logs(job_id, tail) || '(no log yet)' : `not found: ${job_id}`),
  );

  server.registerTool(
    'job_transcript',
    {
      title: 'Job transcript',
      description:
        "The agent's own output, kept after the VM is gone: one JSON event per line for claude and codex, one JSON " +
        'document for antigravity, plain text for pi, nothing for shell. Use it to check what the agent actually ran. ' +
        'grep keeps lines containing that substring; tail keeps the last lines after filtering. Lines over 4000 characters are cut.',
      inputSchema: {
        job_id: z.string(),
        tail: z.number().int().min(1).max(500).default(50),
        grep: z.string().optional(),
      },
    },
    async ({ job_id, tail, grep }) =>
      text(db.get(job_id) ? sched.transcript(job_id, tail, grep) ?? '(no transcript)' : `not found: ${job_id}`),
  );

  server.registerTool(
    'cancel_job',
    { title: 'Cancel a job', description: 'Cancel a queued or running job. Running jobs have their VM stopped and removed.', inputSchema: { job_id: z.string() } },
    async ({ job_id }) => {
      const j = await sched.cancel(job_id);
      return text(j ? view(j, db) : { error: 'not found', job_id });
    },
  );

  server.registerTool(
    'merge_pr',
    {
      title: 'Merge a pull request',
      description:
        'Merge a PR as the bot. Refuses when GitHub reports it not mergeable; then submit a job with branch=<pr head> ' +
        'whose task is to merge the base branch and resolve conflicts, and call this again.',
      inputSchema: {
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        number: z.number().int().positive(),
        method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
        delete_branch: z.boolean().default(true),
      },
    },
    async ({ repo, number, method, delete_branch }) => {
      try {
        return text(await mergePr(creds, repo, number, method, delete_branch));
      } catch (e) {
        return text({ merged: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  server.registerTool(
    'reset_cache',
    {
      title: "Reset a repo's disk",
      description:
        "Delete the repo's golden disk, the cached /nix (Nix store, tools, cache paths) its jobs start from. The next job " +
        "starts from the template and rebuilds what it needs. A job already running on the repo still promotes its disk when it finishes.",
      inputSchema: { repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('GitHub repo as owner/name') },
    },
    async ({ repo }) => text({ repo, deleted: sched.disks.reset(repo) }),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent jobs, newest first. Filter by status.',
      inputSchema: { status: z.enum(JOB_STATUSES).optional(), limit: z.number().int().min(1).max(100).default(20) },
    },
    async ({ status, limit }) => text(db.list(status ?? null, limit).map((j) => view(j, db))),
  );

  return server;
}

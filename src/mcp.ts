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
function view(j: JobRow): Record<string, unknown> {
  const result = j.result ? (JSON.parse(j.result) as Record<string, unknown>) : null;
  return {
    ...j,
    task: j.task.length > 300 ? `${j.task.slice(0, 300)}…` : j.task,
    result,
    url: typeof result?.['pr_url'] === 'string' ? result['pr_url'] : j.status === 'pushed' ? `https://github.com/${j.repo}/tree/${j.branch}` : null,
  };
}

export function buildMcpServer(sched: Scheduler, db: Db, creds: CredentialSource, secretsFile: string): McpServer {
  const server = new McpServer({ name: 'eumaeus', version: '0.1.0' });

  server.registerTool(
    'submit_job',
    {
      title: 'Submit a job',
      description:
        'Queue a coding task. A fresh VM clones <repo> at <base_branch>, runs the agent on <task>, commits, and pushes ' +
        'branch job/<id> and opens a PR. Pass branch= to continue an existing branch/PR instead (the VM checks it out ' +
        'and pushes to it). Returns at once with the job id; poll job_status. Be specific in the task: name files and ' +
        'the expected outcome. Nothing from the VM survives except the pushed branch.',
      inputSchema: {
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('GitHub repo as owner/name'),
        task: z.string().min(1).max(20_000).describe('Instructions for the agent'),
        runner: z.enum(RUNNERS).default('claude').describe(
          'claude = Claude Code; codex = OpenAI Codex CLI; antigravity = Google agy; pi = pi (any provider, give model as provider/id); shell = run task as bash (testing)'),
        model: z.string().optional().describe('Model override. claude/codex/antigravity: vendor model id. pi: provider/model or a fuzzy name like "sonnet"'),
        base_branch: z.string().default('main'),
        branch: z.string().optional().describe('Existing branch to continue (e.g. a PR head). Default: new job/<id>'),
        cpus: z.number().int().min(1).max(8).optional(),
        memory: z.string().regex(/^\d+[MG]$/).optional().describe('e.g. 4G'),
      },
    },
    async (args) => {
      const missing = missingSecret(args.runner, secretsFile);
      if (missing) return text({ error: missing });
      return text(view(sched.submit(args)));
    },
  );

  server.registerTool(
    'job_status',
    { title: 'Job status', description: 'Current state of one job, including its result JSON and branch URL once pushed.', inputSchema: { job_id: z.string() } },
    async ({ job_id }) => {
      const j = db.get(job_id);
      return text(j ? view(j) : { error: 'not found', job_id });
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
      return text(j ? view(j) : { error: 'not found', job_id });
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
    async ({ status, limit }) => text(db.list(status ?? null, limit).map(view)),
  );

  return server;
}

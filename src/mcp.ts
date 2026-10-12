import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JOB_STATUSES, type Db, type JobRow } from './db.ts';
import type { Scheduler } from './jobs.ts';

const text = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

/** Trim the row for tool output: the task can be long and the result is JSON-in-a-string. */
function view(j: JobRow): Record<string, unknown> {
  return {
    ...j,
    task: j.task.length > 300 ? `${j.task.slice(0, 300)}…` : j.task,
    result: j.result ? (JSON.parse(j.result) as unknown) : null,
    url: j.status === 'pushed' ? `https://github.com/${j.repo}/tree/${j.branch}` : null,
  };
}

export function buildMcpServer(sched: Scheduler, db: Db): McpServer {
  const server = new McpServer({ name: 'eumaeus', version: '0.1.0' });

  server.registerTool(
    'submit_job',
    {
      title: 'Submit a job',
      description:
        'Queue a coding task. A fresh VM clones <repo> at <base_branch>, runs the agent on <task>, commits, and pushes ' +
        'branch job/<id>. Returns at once with the job id; poll job_status. Be specific in the task: name files and the ' +
        'expected outcome. Nothing from the VM survives except the pushed branch.',
      inputSchema: {
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).describe('GitHub repo as owner/name'),
        task: z.string().min(1).max(20_000).describe('Instructions for the agent'),
        runner: z.enum(['claude', 'shell']).default('claude').describe('claude = Claude Code headless; shell = run task as bash (testing)'),
        model: z.string().optional().describe('Model override passed to the runner'),
        base_branch: z.string().default('main'),
        cpus: z.number().int().min(1).max(8).optional(),
        memory: z.string().regex(/^\d+[MG]$/).optional().describe('e.g. 4G'),
      },
    },
    async (args) => text(view(sched.submit(args))),
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
    'cancel_job',
    { title: 'Cancel a job', description: 'Cancel a queued or running job. Running jobs have their VM stopped and removed.', inputSchema: { job_id: z.string() } },
    async ({ job_id }) => {
      const j = await sched.cancel(job_id);
      return text(j ? view(j) : { error: 'not found', job_id });
    },
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

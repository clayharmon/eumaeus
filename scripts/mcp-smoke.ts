// End-to-end check against a running dispatcher: list tools, submit a shell job, poll to completion.
// Usage: node scripts/mcp-smoke.ts <owner/repo> [url]. Opens a real PR on <owner/repo>; use a scratch repo.
// SMOKE_RUNNER / SMOKE_TASK override the shell job. Sends `Authorization: Bearer $EUMAEUS_AUTH_TOKEN`, read from the env or ~/.config/eumaeus/dispatcher.env.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repo = process.argv[2];
const url = process.argv[3] ?? 'http://127.0.0.1:7777/mcp';
if (!repo) {
  console.error('usage: node scripts/mcp-smoke.ts <owner/repo> [url]');
  process.exit(2);
}

function authToken(): string | undefined {
  if (process.env['EUMAEUS_AUTH_TOKEN']) return process.env['EUMAEUS_AUTH_TOKEN'];
  const f = `${homedir()}/.config/eumaeus/dispatcher.env`;
  if (!existsSync(f)) return undefined;
  return /^EUMAEUS_AUTH_TOKEN=(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim();
}
const token = authToken();

const client = new Client({ name: 'eumaeus-smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const firstText = (r: Awaited<ReturnType<Client['callTool']>>): string => {
  const c = (r.content as { type: string; text?: string }[])[0];
  return c?.text ?? '';
};

const submitted = JSON.parse(firstText(await client.callTool({
  name: 'submit_job',
  arguments: {
    repo,
    runner: process.env['SMOKE_RUNNER'] ?? 'shell',
    task: process.env['SMOKE_TASK'] ?? 'mkdir -p jobs && printf "# eumaeus smoke\\n\\nsubmitted over MCP at %s\\n" "$(date -u +%FT%TZ)" > jobs/smoke.md',
  },
}))) as { id: string; status: string; branch: string };
console.log('submitted:', submitted.id, submitted.status, submitted.branch);

const t0 = Date.now();
let job = submitted as { id: string; status: string; branch: string; url?: string; error?: string };
while (['queued', 'running'].includes(job.status)) {
  await new Promise((r) => setTimeout(r, 1000));
  job = JSON.parse(firstText(await client.callTool({ name: 'job_status', arguments: { job_id: submitted.id } })));
}
console.log(`final: ${job.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`, job.url ?? job.error ?? '');
console.log('--- log tail ---');
console.log(firstText(await client.callTool({ name: 'job_logs', arguments: { job_id: submitted.id, tail: 15 } })));
await client.close();
process.exit(job.status === 'pushed' ? 0 : 1);

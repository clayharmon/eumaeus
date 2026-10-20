// Call one tool on a running dispatcher and print what it returns. Plan Checks use it against a dev dispatcher.
// Usage: node scripts/mcp-call.ts <url> <tool> ['<json arguments>']
//   node scripts/mcp-call.ts http://127.0.0.1:7778/mcp submit_job '{"repo":"clayharmon/eumaeus-fixtures","runner":"shell","task":"true"}'
//   node scripts/mcp-call.ts http://127.0.0.1:7778/mcp job_status '{"job_id":"<id>"}'
// Sends `Authorization: Bearer $EUMAEUS_AUTH_TOKEN`, read from the env or ~/.config/eumaeus/dispatcher.env. A dispatcher
// started without the variable ignores the header.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, tool, json] = process.argv.slice(2);
if (!url || !tool) {
  console.error("usage: node scripts/mcp-call.ts <url> <tool> ['<json arguments>']");
  process.exit(2);
}

function authToken(): string | undefined {
  if (process.env['EUMAEUS_AUTH_TOKEN']) return process.env['EUMAEUS_AUTH_TOKEN'];
  const f = `${homedir()}/.config/eumaeus/dispatcher.env`;
  if (!existsSync(f)) return undefined;
  return /^EUMAEUS_AUTH_TOKEN=(.+)$/m.exec(readFileSync(f, 'utf8'))?.[1]?.trim();
}
const token = authToken();

const client = new Client({ name: 'eumaeus-call', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
const r = await client.callTool({ name: tool, arguments: json ? (JSON.parse(json) as Record<string, unknown>) : {} });
for (const c of r.content as { type: string; text?: string }[]) if (c.text) console.log(c.text);
await client.close();
process.exit(r.isError ? 1 : 0);

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.ts';
import type { CredentialSource } from './credentials.ts';
import type { Db } from './db.ts';
import type { Inbox } from './inbox.ts';
import type { Scheduler } from './jobs.ts';
import { buildMcpServer } from './mcp.ts';
import { dispatcherCommit, imageCommit } from './version.ts';

const MAX_BODY = 1_000_000;

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Stateless streamable-HTTP MCP endpoint: one McpServer + transport per request.
 * JSON responses (no SSE) keep it curl-friendly and proxy-friendly.
 */
export function startHttp(cfg: Config, sched: Scheduler, db: Db, creds: CredentialSource, inbox: Inbox, log: (s: string) => void): Server {
  const commit = dispatcherCommit();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      json(res, 200, {
        ok: true,
        running: sched.activeCount(),
        queued: db.count('queued'),
        paused: sched.paused(),
        commit,
        image: cfg.image,
        image_commit: await imageCommit(cfg.image),
        inbox: inbox.status(),
      });
      return;
    }
    if (url.pathname !== '/mcp') { json(res, 404, { error: 'not found' }); return; }
    if (cfg.authToken && req.headers.authorization !== `Bearer ${cfg.authToken}`) {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJson(req) : undefined;
      const mcp = buildMcpServer(sched, db, creds, cfg.secretsFile, commit, inbox.describe());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`mcp error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });

  server.listen(cfg.port, cfg.host, () => log(`listening on http://${cfg.host}:${cfg.port}/mcp (auth: ${cfg.authToken ? 'bearer' : 'none'})`));
  return server;
}

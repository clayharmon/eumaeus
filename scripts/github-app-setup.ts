// One-time GitHub App creation via the App Manifest flow.
// Serves http://localhost:7778: the page posts a manifest to GitHub, you click "Create GitHub App",
// GitHub redirects back with a code, the script exchanges it for the app's id + private key and
// writes ~/.config/eumaeus/github-app.json (0600), then sends you to the install page and waits.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { appJwt, ghApi, type GitHubAppConfig } from '../src/github.ts';

const PORT = Number(process.env['PORT'] ?? 7778);
const OUT = resolve((process.env['EUMAEUS_GITHUB_APP'] ?? '~/.config/eumaeus/github-app.json').replace(/^~/, homedir()));
const APP_NAME = process.env['APP_NAME'] ?? 'eumaeus';
const ORG = process.env['GITHUB_ORG']; // unset = personal account
const state = randomBytes(16).toString('hex');

const manifest = {
  name: APP_NAME,
  url: 'https://github.com/clayharmon/eumaeus',
  description: 'Self-hosted agent harness. Pushes branches and opens pull requests for jobs.',
  redirect_url: `http://localhost:${PORT}/callback`,
  public: false,
  default_permissions: {
    contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read', issues: 'read',
    // src/ci.ts reads check runs, commit statuses, and Actions job logs.
    checks: 'read', statuses: 'read', actions: 'read',
  },
  default_events: [],
};

const createUrl = ORG ? `https://github.com/organizations/${ORG}/settings/apps/new?state=${state}` : `https://github.com/settings/apps/new?state=${state}`;

const page = (body: string): string => `<!doctype html><meta charset="utf-8"><title>eumaeus setup</title>
<style>body{font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.1em .3em}</style>${body}`;

interface Conversion { id: number; slug: string; pem: string; html_url: string; client_id: string }

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(`<h1>Create the eumaeus GitHub App</h1>
<p>This posts the app definition to GitHub. On the next page, change the name if "${APP_NAME}" is taken, then click <b>Create GitHub App</b>.</p>
<p>Permissions: contents, pull requests, workflows (write); metadata, issues (read). No webhook.</p>
<form method="post" action="${createUrl}"><input type="hidden" name="manifest" value='${JSON.stringify(manifest).replaceAll("'", '&#39;')}'>
<button style="font-size:1.1em;padding:.5em 1em">Continue to GitHub</button></form>`));
    return;
  }
  if (url.pathname === '/callback') {
    if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('bad state'); return; }
    const code = url.searchParams.get('code') ?? '';
    try {
      const c = await ghApi<Conversion>(`/app-manifests/${code}/conversions`, null, { method: 'POST' });
      const bot = await ghApi<{ id: number }>(`/users/${encodeURIComponent(`${c.slug}[bot]`)}`, null);
      const cfg: GitHubAppConfig = { app_id: c.id, slug: c.slug, pem: c.pem, bot_user_id: bot.id, html_url: c.html_url };
      mkdirSync(dirname(OUT), { recursive: true, mode: 0o700 });
      writeFileSync(OUT, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
      chmodSync(OUT, 0o600);
      console.log(`created app ${c.slug} (id ${c.id}), bot user ${bot.id}; wrote ${OUT}`);
      const install = `https://github.com/apps/${c.slug}/installations/new`;
      res.writeHead(200, { 'content-type': 'text/html', refresh: `2; url=${install}` });
      res.end(page(`<h1>App created: ${c.slug}</h1><p>Credentials saved to <code>${OUT}</code>.</p><p>Next: install it on your account and pick the repos. Redirecting to <a href="${install}">${install}</a>…</p>`));
      void waitForInstall(cfg);
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'content-type': 'text/html' });
      res.end(page(`<h1>Failed</h1><pre>${e instanceof Error ? e.message : String(e)}</pre>`));
    }
    return;
  }
  res.writeHead(404); res.end();
});

async function waitForInstall(cfg: GitHubAppConfig): Promise<void> {
  console.log('waiting for an installation (up to 10 min)…');
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const list = await ghApi<{ id: number; account: { login: string }; repository_selection: string }[]>('/app/installations', appJwt(cfg));
      if (list.length) {
        for (const ins of list) console.log(`installed on ${ins.account.login} (installation ${ins.id}, repos: ${ins.repository_selection})`);
        server.close(); process.exit(0);
      }
    } catch (e) { console.error(`poll: ${e instanceof Error ? e.message : String(e)}`); }
  }
  console.error('gave up waiting; install later at ' + cfg.html_url); server.close(); process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => console.log(`open http://localhost:${PORT} in your browser`));

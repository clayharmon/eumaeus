import { sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** Stored by scripts/github-app-setup.ts at ~/.config/eumaeus/github-app.json (0600). */
export interface GitHubAppConfig {
  app_id: number;
  slug: string;
  pem: string;
  bot_user_id: number;
  html_url: string;
}

export function loadGitHubApp(path: string): GitHubAppConfig | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as GitHubAppConfig;
}

/** RS256 app JWT, valid 9 minutes, clock skew allowed 60 s. */
export function appJwt(app: GitHubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const body = b64({ iat: now - 60, exp: now + 9 * 60, iss: String(app.app_id) });
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), app.pem).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export async function ghApi<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'eumaeus',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com${path}`, { ...init, headers });
  if (!r.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  // 204: a DELETE, or a POST with nothing to return.
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export interface RateLimit {
  remaining: number;
  limit: number;
  /** Epoch milliseconds. */
  reset: number;
}

/** GitHub refused for rate: the primary limit (remaining 0) or a secondary limit (retry-after). */
export class RateLimited extends Error {
  readonly until: number;
  constructor(until: number, message: string) {
    super(message);
    this.until = until;
  }
}

export interface Conditional<T> {
  /** null on a 304: nothing changed since the ETag sent. */
  body: T | null;
  status: 200 | 304;
  etag: string | null;
  /** The rel="next" page, a full URL. */
  next: string | null;
  rate: RateLimit | null;
}

/**
 * GET with If-None-Match. GitHub doesn't count a 304 against the rate limit, and its ETags differ per token,
 * so a caller keeps one token for as long as it can. `path` is an API path or a full URL from a Link header.
 */
export async function ghGet<T>(path: string, token: string, etag: string | null = null): Promise<Conditional<T>> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'eumaeus',
    authorization: `Bearer ${token}`,
  };
  if (etag) headers['if-none-match'] = etag;
  const r = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, { headers });
  const h = (k: string): number | null => (r.headers.has(k) ? Number(r.headers.get(k)) : null);
  const remaining = h('x-ratelimit-remaining');
  const rate = remaining === null ? null : { remaining, limit: h('x-ratelimit-limit') ?? 0, reset: (h('x-ratelimit-reset') ?? 0) * 1000 };
  if (r.status === 304) return { body: null, status: 304, etag, next: null, rate };
  if (r.status === 403 || r.status === 429) {
    const retry = h('retry-after');
    if (remaining === 0 && rate) throw new RateLimited(rate.reset, `rate limit spent until ${new Date(rate.reset).toISOString()}`);
    if (retry !== null) throw new RateLimited(Date.now() + retry * 1000, `secondary rate limit, retry after ${retry} s`);
  }
  if (!r.ok) throw new Error(`GitHub GET ${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1] ?? null;
  return { body: (await r.json()) as T, status: 200, etag: r.headers.get('etag'), next, rate };
}

export interface InstallationToken {
  token: string;
  expires_at: string;
}

export class GitHubApp {
  readonly cfg: GitHubAppConfig;
  private readonly installations = new Map<string, number>();

  constructor(cfg: GitHubAppConfig) {
    this.cfg = cfg;
  }

  get botLogin(): string {
    return `${this.cfg.slug}[bot]`;
  }

  /** Commits with this email are attributed to the bot on github.com. */
  get botEmail(): string {
    return `${this.cfg.bot_user_id}+${this.cfg.slug}[bot]@users.noreply.github.com`;
  }

  /** One-hour token scoped to a single repository. Throws if the app is not installed there. */
  async installationToken(owner: string, repo: string): Promise<InstallationToken> {
    const key = `${owner}/${repo}`;
    const jwt = appJwt(this.cfg);
    let inst = this.installations.get(key);
    if (inst === undefined) {
      try {
        inst = (await ghApi<{ id: number }>(`/repos/${owner}/${repo}/installation`, jwt)).id;
      } catch (e) {
        throw new Error(`GitHub App "${this.cfg.slug}" is not installed on ${key}: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.installations.set(key, inst);
    }
    return ghApi<InstallationToken>(`/app/installations/${inst}/access_tokens`, jwt, {
      method: 'POST',
      body: JSON.stringify({ repositories: [repo] }),
    });
  }

  /** One-hour token for every repo of an installation. It stays in the dispatcher; src/inbox.ts polls with it. */
  installationTokenAll(installationId: number): Promise<InstallationToken> {
    return ghApi<InstallationToken>(`/app/installations/${installationId}/access_tokens`, appJwt(this.cfg), { method: 'POST' });
  }

  listInstallations(): Promise<{ id: number; account: { login: string; type: string }; repository_selection: string }[]> {
    return ghApi(`/app/installations`, appJwt(this.cfg));
  }
}

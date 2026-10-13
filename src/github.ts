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
  return (await r.json()) as T;
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

  listInstallations(): Promise<{ id: number; account: { login: string; type: string }; repository_selection: string }[]> {
    return ghApi(`/app/installations`, appJwt(this.cfg));
  }
}

import { execFileSync } from 'node:child_process';
import { GitHubApp, loadGitHubApp } from './github.ts';

/** What a job VM needs to clone, push, and open a PR as some identity. */
export interface GitIdentity {
  token: string;
  name: string;
  email: string;
  source: 'github-app' | 'gh-cli';
}

export interface CredentialSource {
  readonly describe: string;
  identityFor(repo: string): Promise<GitIdentity>;
}

/** Preferred: per-job installation token scoped to one repo, commits and PRs attributed to the bot. */
export class GitHubAppCredentials implements CredentialSource {
  readonly describe: string;
  private readonly app: GitHubApp;

  constructor(app: GitHubApp) {
    this.app = app;
    this.describe = `github-app ${app.botLogin} (app ${app.cfg.app_id})`;
  }

  async identityFor(repo: string): Promise<GitIdentity> {
    const [owner, name] = repo.split('/') as [string, string];
    const t = await this.app.installationToken(owner, name);
    return { token: t.token, name: this.app.botLogin, email: this.app.botEmail, source: 'github-app' };
  }
}

/** Fallback: the developer's own `gh` login. Broad scope, commits appear as you. */
export class GhCliCredentials implements CredentialSource {
  readonly describe: string;
  private readonly user: string;

  constructor(user: string) {
    this.user = user;
    this.describe = `gh-cli token for ${user || 'the active gh account'} (personal, broad scope)`;
  }

  async identityFor(): Promise<GitIdentity> {
    const token = execFileSync('gh', ['auth', 'token', ...(this.user ? ['-u', this.user] : [])], { encoding: 'utf8' }).trim();
    return { token, name: 'eumaeus', email: 'eumaeus@users.noreply.github.com', source: 'gh-cli' };
  }
}

export function pickCredentials(appConfigPath: string, ghUser: string): CredentialSource {
  const app = loadGitHubApp(appConfigPath);
  return app ? new GitHubAppCredentials(new GitHubApp(app)) : new GhCliCredentials(ghUser);
}

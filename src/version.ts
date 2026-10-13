import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Short commit of this checkout, suffixed -dirty when src/ differs from it. Null outside a git checkout. */
export function dispatcherCommit(): string | null {
  try {
    const git = (...args: string[]): string => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = git('rev-parse', '--short', 'HEAD');
    return git('status', '--porcelain', '--', 'src') ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

const IMAGE_TTL_MS = 10_000;
let imageCache: { image: string; at: number; commit: string | null } | null = null;

/** EUMAEUS_COMMIT from the job image's env, as scripts/build-image.sh stamps it. Cached for 10 s. */
export async function imageCommit(image: string): Promise<string | null> {
  if (imageCache && imageCache.image === image && Date.now() - imageCache.at < IMAGE_TTL_MS) return imageCache.commit;
  let commit: string | null = null;
  try {
    const { stdout } = await promisify(execFile)('container', ['image', 'inspect', image], { timeout: 5_000 });
    const parsed = JSON.parse(stdout) as { variants?: { config?: { config?: { Env?: string[] } } }[] }[];
    const env = parsed[0]?.variants?.flatMap((v) => v.config?.config?.Env ?? []) ?? [];
    commit = env.find((e) => e.startsWith('EUMAEUS_COMMIT='))?.slice('EUMAEUS_COMMIT='.length) ?? null;
  } catch {
    // No such image, or `container` isn't running: report null.
  }
  imageCache = { image, at: Date.now(), commit };
  return commit;
}

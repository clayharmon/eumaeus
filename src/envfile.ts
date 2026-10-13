import { parse } from 'smol-toml';
import { z } from 'zod';

/** .eumaeus.toml (docs/m5-environments.md). Unknown keys are an error, so a typo fails the job instead of hiding. */
const Schema = z.strictObject({
  setup: z.string().optional(),
  shell: z.string().optional(),
  cache: z.array(z.string().regex(/^[^\n]+$/, 'one path per entry, no newlines')).optional(),
});
export type EnvToml = z.infer<typeof Schema>;

/**
 * .eumaeus.toml at the first of `refs` that has it, through the contents API. Null when none does. Throws on an
 * API error or a malformed file, so the job fails before a VM boots. A 404 means no such file or no such ref.
 */
export async function readEnvToml(repo: string, refs: string[], token: string): Promise<EnvToml | null> {
  for (const ref of refs) {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/.eumaeus.toml?ref=${encodeURIComponent(ref)}`, {
      headers: {
        accept: 'application/vnd.github.raw+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'eumaeus',
        authorization: `Bearer ${token}`,
      },
    });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`GitHub contents .eumaeus.toml at ${ref} -> ${r.status}`);
    let data: unknown;
    try {
      data = parse(await r.text());
    } catch (e) {
      throw new Error(`.eumaeus.toml at ${ref}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
    const res = Schema.safeParse(data);
    if (!res.success) throw new Error(`.eumaeus.toml at ${ref}: ${z.prettifyError(res.error).replace(/\n/g, '; ')}`);
    return res.data;
  }
  return null;
}

/** `container run -e` arguments for job.sh. Only the keys the file sets, so job.sh can tell unset from empty. */
export function envArgs(t: EnvToml | null): string[] {
  if (!t) return [];
  const a = ['-e', 'EUMAEUS_TOML=1'];
  if (t.setup !== undefined) a.push('-e', `SETUP=${t.setup}`);
  if (t.shell !== undefined) a.push('-e', `SHELL_PREFIX=${t.shell}`);
  if (t.cache !== undefined) a.push('-e', `CACHE=${t.cache.join('\n')}`);
  return a;
}

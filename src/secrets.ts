import { existsSync, readFileSync } from 'node:fs';

export const RUNNERS = ['claude', 'codex', 'antigravity', 'pi', 'shell'] as const;
export type Runner = (typeof RUNNERS)[number];

/** Which env vars satisfy each runner. Any one of the listed names is enough. */
export const RUNNER_SECRETS: Record<Runner, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  antigravity: ['GEMINI_API_KEY'],
  pi: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY'],
  shell: [],
};

/** Names (not values) defined in the secrets env file. */
export function secretNames(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const names = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

/** Null when the runner can start; otherwise a message naming what to add to the secrets file. */
export function missingSecret(runner: Runner, path: string): string | null {
  const need = RUNNER_SECRETS[runner];
  if (need.length === 0) return null;
  const have = secretNames(path);
  if (need.some((n) => have.has(n))) return null;
  return `runner "${runner}" needs one of ${need.join(', ')} in ${path}`;
}

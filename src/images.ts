import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.ts';

const run = promisify(execFile);
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** Images kept per repo, most recently used first. A branch that edits the Dockerfile builds its own, and keeping a
 * few stops two branches from rebuilding each other's. */
const KEEP_PER_REPO = 3;

/** Builds in flight, by tag, so two jobs on one repo wait for one build. */
const building = new Map<string, Promise<void>>();

/**
 * The image a repo's jobs boot from when its .eumaeus.toml sets `image` (docs/m5-environments.md, M6). The
 * Dockerfile builds on the job image through `ARG BASE` / `FROM $BASE`, with that one file as the whole build
 * context. The tag hashes the Dockerfile and the base image's id, so a change to either builds a new image. After a
 * build, the repo keeps its 3 most recently used images; `container` records no build time of its own, so
 * $EUMAEUS_DATA/images.json records each tag's last use.
 */
export async function repoImage(cfg: Config, repo: string, dockerfile: string, log: (s: string) => void): Promise<string> {
  const first = /^\s*FROM\s+(\S+)/im.exec(dockerfile)?.[1];
  if (!/^ARG\s+BASE\b/im.test(dockerfile) || !first || !/^\$\{?BASE\}?$/.test(first)) {
    throw new Error('the Dockerfile must declare ARG BASE and start FROM $BASE, so it builds on the job image');
  }
  const baseId = await imageId(cfg.image);
  if (!baseId) throw new Error(`base image ${cfg.image} not found`);
  const name = `eumaeus-env-${repo.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`;
  const tag = `${name}:${createHash('sha256').update(`${dockerfile}\n${baseId}`).digest('hex').slice(0, 12)}`;
  if (await imageId(tag)) {
    markUsed(cfg, tag);
    log(`image: ${tag} (built earlier)`);
    return tag;
  }
  let build = building.get(tag);
  if (!build) {
    build = buildImage(cfg, tag, dockerfile, log).finally(() => building.delete(tag));
    building.set(tag, build);
  } else {
    log(`image: waiting for another job's build of ${tag}`);
  }
  await build;
  markUsed(cfg, tag);
  await pruneRepoImages(cfg, name, log);
  return tag;
}

async function buildImage(cfg: Config, tag: string, dockerfile: string, log: (s: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eumaeus-image-'));
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);
  const t0 = Date.now();
  log(`image: building ${tag}`);
  try {
    await run('container', ['builder', 'start']).catch(() => undefined);
    const lines: string[] = [];
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn('container', ['build', '--progress', 'plain', '--build-arg', `BASE=${cfg.image}`, '-t', tag, '-f', join(dir, 'Dockerfile'), dir],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: BUILD_TIMEOUT_MS });
      const keep = (d: Buffer): void => { lines.push(...d.toString().split('\n').filter(Boolean)); if (lines.length > 400) lines.splice(0, lines.length - 400); };
      p.stdout.on('data', keep);
      p.stderr.on('data', keep);
      p.on('close', resolve);
      p.on('error', () => resolve(null));
    });
    if (code !== 0) {
      for (const l of lines.slice(-40)) log(`image: ${l}`);
      throw new Error(`container build of ${tag} exited ${code}`);
    }
    log(`image: built ${tag} in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // The builder VM holds 2 CPUs and 2 GB while it runs; stop it when no other build needs it.
    if (building.size <= 1) await run('container', ['builder', 'stop']).catch(() => undefined);
  }
}

const usedFile = (cfg: Config): string => join(cfg.dataDir, 'images.json');

function readUsed(cfg: Config): Record<string, string> {
  try {
    return existsSync(usedFile(cfg)) ? (JSON.parse(readFileSync(usedFile(cfg), 'utf8')) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function markUsed(cfg: Config, tag: string): void {
  const used = readUsed(cfg);
  used[tag] = new Date().toISOString();
  writeFileSync(usedFile(cfg), `${JSON.stringify(used, null, 1)}\n`);
}

/** Keep the repo's KEEP_PER_REPO most recently used images; remove the rest. */
async function pruneRepoImages(cfg: Config, name: string, log: (s: string) => void): Promise<void> {
  try {
    const { stdout } = await run('container', ['image', 'list', '--format', 'json']);
    const used = readUsed(cfg);
    const old = (JSON.parse(stdout) as { configuration?: { name?: string } }[])
      .map((i) => i.configuration?.name ?? '')
      .filter((n) => n.startsWith(`${name}:`))
      .sort((a, b) => (used[b] ?? '').localeCompare(used[a] ?? ''))
      .slice(KEEP_PER_REPO);
    for (const n of old) {
      await run('container', ['image', 'rm', n]);
      delete used[n];
      log(`image: removed ${n}, the least recently used of this repo's images`);
    }
    writeFileSync(usedFile(cfg), `${JSON.stringify(used, null, 1)}\n`);
  } catch { /* best effort; the next build tries again */ }
}

async function imageId(ref: string): Promise<string | null> {
  try {
    const { stdout } = await run('container', ['image', 'inspect', ref]);
    return (JSON.parse(stdout) as { id?: string }[])[0]?.id ?? null;
  } catch {
    return null;
  }
}

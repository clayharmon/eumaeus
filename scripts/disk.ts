// Per-repo disks (docs/m5-environments.md).
// Usage: node scripts/disk.ts template [--if-stale] # build the template disk: Nix, devenv, devbox, mise, Flox;
//                                                   # --if-stale skips it unless it is missing or its Nix is not NIX_VERSION
//        node scripts/disk.ts ls                    # disks on the host, free space, and the limits
//        node scripts/disk.ts reset <owner/name>    # delete a repo's golden disk
// Reads ~/.config/eumaeus/dispatcher.env first (without overriding the environment), like the launchd agent does.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const envFile = process.env['EUMAEUS_ENV_FILE'] ?? join(homedir(), '.config/eumaeus/dispatcher.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
const { config } = await import('../src/config.ts');
const { Disks, NIX_VERSION, TOOL_PROFILE, removeVolume, volumeSource } = await import('../src/disks.ts');

/** Run a command with output on this terminal; reject on a non-zero exit. */
function sh(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.slice(0, 2).join(' ')} exited ${code}`))));
  });
}

// Runs as `agent` with the new volume at /nix. The installer's own profile lands in the VM's home, which is
// discarded, so the tools go into a second profile on the disk.
const INSTALL = [
  'set -euo pipefail',
  `curl -fsSL https://releases.nixos.org/nix/nix-${NIX_VERSION}/install -o /tmp/install-nix`,
  'sh /tmp/install-nix --no-daemon --no-modify-profile --no-channel-add',
  'nix="$(readlink -f ~/.nix-profile/bin/nix)"',
  `"$nix" profile add --profile ${TOOL_PROFILE} "\${nix%/bin/nix}" nixpkgs#devenv nixpkgs#devbox nixpkgs#mise`,
  `"$nix" profile add --profile ${TOOL_PROFILE} --accept-flake-config github:flox/flox/latest \\`,
  '  || echo "flox did not install; repos with .flox/ get no shell prefix" >&2',
  'for t in nix devenv devbox mise flox; do printf "%s: %s\\n" "$t" "$(command -v "$t" || echo missing)"; done',
  'du -sh /nix/store',
].join('\n');

async function buildTemplate(): Promise<void> {
  const disks = new Disks(config);
  const vol = 'eumaeus-template-build';
  const base = ['run', '--rm', '--progress', 'none', '--name', vol, '-v', `${vol}:/nix`];
  await removeVolume(vol);
  await sh('container', ['volume', 'create', '-s', config.diskSize, vol]);
  try {
    // A fresh volume's root is root:root 0755; the agent user (uid 1000) has to own it.
    await sh('container', [...base, '--user', 'root', '--entrypoint', 'chown', config.image, 'agent:agent', '/nix']);
    await sh('container', [...base, '--cpus', '4', '--memory', '4G', '--entrypoint', 'bash', config.image, '-c', INSTALL]);
    const src = await volumeSource(vol);
    if (!src) throw new Error(`container volume inspect ${vol} has no configuration.source`);
    mkdirSync(disks.dir, { recursive: true });
    await sh('cp', ['-c', src, `${disks.template}.tmp`]);
    renameSync(`${disks.template}.tmp`, disks.template);
    writeFileSync(marker(), JSON.stringify({ nix_version: NIX_VERSION, built_at: new Date().toISOString() }) + '\n');
    console.log(`template: ${disks.template}`);
  } finally {
    // container 1.5 honors --rm only on exit 0.
    await new Promise((r) => spawn('container', ['rm', '-f', vol], { stdio: 'ignore' }).on('close', r));
    await removeVolume(vol);
  }
}

/** Records the Nix version the template was built with, so `--if-stale` can tell when to rebuild it. */
const marker = (): string => join(new Disks(config).dir, 'template.json');

/** Why the template needs building, or null when it is current. A template from before the marker counts as current. */
function stale(): string | null {
  const disks = new Disks(config);
  if (!existsSync(disks.template)) return 'missing';
  if (!existsSync(marker())) {
    writeFileSync(marker(), JSON.stringify({ nix_version: NIX_VERSION, built_at: statSync(disks.template).mtime.toISOString() }) + '\n');
    return null;
  }
  const built = (JSON.parse(readFileSync(marker(), 'utf8')) as { nix_version?: string }).nix_version;
  return built === NIX_VERSION ? null : `built with Nix ${built}, want ${NIX_VERSION}`;
}

function list(): void {
  const disks = new Disks(config);
  const g = (n: number): string => `${(n / 2 ** 30).toFixed(1).padStart(6)} GB`;
  // Blocks shared between APFS clones count in full for each file, so the column can add up past what is used.
  for (const d of disks.list()) console.log(`${g(d.bytes)}  last job ${d.used.toISOString().slice(0, 16)}  ${d.repo}`);
  if (existsSync(disks.template)) console.log(`${g(statSync(disks.template).blocks * 512)}  template`);
  console.log(`free on the Mac: ${g(disks.freeBytes()).trim()}; reset over ${g(config.diskMaxBytes).trim()}, ` +
    `below ${g(config.diskFreeBytes).trim()} free, or after ${config.diskIdleMs / 86_400_000} idle days`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'template') {
  const why = arg === '--if-stale' || arg === '--if-missing' ? stale() : 'asked';
  if (why === null) console.log(`template: ${new Disks(config).template} (current)`);
  else { console.log(`building the template (${why})`); await buildTemplate(); }
} else if (cmd === 'ls') {
  list();
} else if (cmd === 'reset' && arg && /^[\w.-]+\/[\w.-]+$/.test(arg)) {
  console.log(new Disks(config).reset(arg) ? `deleted the golden disk for ${arg}` : `${arg} has no golden disk`);
} else {
  console.error('usage: node scripts/disk.ts template [--if-stale] | ls | reset <owner/name>');
  process.exit(2);
}

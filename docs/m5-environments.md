# M5: per-repo environments

Status: plan. Nothing below is built. Measurements are from an Apple silicon Mac on `container` 1.5.0.

## A job can't run the checks it is asked to pass

Take a Rust service whose CI runs `cargo clippy` and `cargo test` against a live Postgres. A task for it
usually ends with "make CI pass." The job VM boots `eumaeus-job:dev`: Debian bookworm, Node 24, git, gh,
ripgrep, jq, and four agent CLIs. It has no Rust, no C compiler, and no Postgres. The agent runs as uid 1000
with no sudo.

So the agent either installs a toolchain under `~` and goes looking for a linker and a database it can't
`apt-get`, or it skips the checks and the PR goes out untested. The VM is deleted at exit, so the next job on
that repo starts from zero again.

## Three fixes that don't work

**Add the tools to the job image.** One image then carries every repo's toolchain. Two repos that pin
different Rust or Postgres versions can't both be satisfied, and adding a repo rebuilds the image for all of
them.

**Mount a cache volume per repo.** A `container` volume is an ext4 image file attached to the VM as a block
device. A second VM that names a volume already attached fails at boot:

```
Error Domain=VZErrorDomain Code=2 "The storage device attachment is invalid."
```

`EUMAEUS_MAX_CONCURRENT=2` lets two jobs on one repo run at once, so they can't share a volume.

**Bind-mount a host directory.** A bind mount attaches to any number of VMs, over virtiofs. Writing, reading,
and deleting 5,000 small files took:

| Where | Time |
|---|---|
| VM root disk | 186 ms |
| `container` volume (ext4) | 223 ms |
| Bind mount (virtiofs) | 6,166 ms |

`target/`, `node_modules`, and package stores are small-file workloads.

## Requirements

- The repo picks its environment tool. eumaeus's own config format names no tool.
- The agent runs without root, as today.
- Two jobs on one repo run at once, as today.
- A job that times out, is cancelled, or fails `setup` doesn't change what the next job on that repo starts
  from.
- A repo that declares nothing runs as it does today.
- Setup on the host Mac works over ssh, with no GUI step.

## The model: two commands from the repo, one disk per repo

The repo supplies two commands:

- `setup` runs once per job, after the clone and before the agent. It starts services and prepares data, for
  example starting Postgres and running migrations.
- `shell` is a prefix eumaeus puts in front of the agent command. The agent and every command it runs inherit
  the environment that prefix sets up.

eumaeus keeps one disk per repo. Every job boots on a copy-on-write clone of that repo's last good disk,
mounted at `/nix`. A job whose `setup` worked and whose VM exited on its own makes its disk the repo's last
good disk, whether or not the agent's work passed. A timeout, a cancel, or a failed `setup` discards it. Agent
failures are the common case, and the toolchain and build output a failed job leaves are as reusable as a
successful job's.

Terms used below:

- **Disk:** an ext4 image file on the host, attached to one VM as a `container` volume.
- **Golden disk:** a repo's last good disk, kept at `$EUMAEUS_DATA/disks/<owner>__<name>.img`.
- **Template disk:** what a repo's first job boots on. It holds a Nix install and nothing else.
- **Promote:** replace the golden disk with a finished job's disk.

## Declaring the environment

### `.eumaeus.toml`

```toml
setup = "devenv up -d"            # once per job, before the agent
shell = "devenv shell --"         # prefix on the agent command
cache = ["target", "~/.cargo"]    # kept on the disk between jobs
```

Every key is optional. The dispatcher reads the file through the GitHub contents API with the job's
installation token, at the branch the job will check out, before the VM starts. A malformed file then fails
the job before a VM boots, and the parser is TypeScript with tests instead of shell.

### Without the file: detect by filename

| File in the repo root | `setup` | `shell` |
|---|---|---|
| `devenv.nix` | `devenv up -d && devenv processes wait --timeout 120` | `devenv shell --` |
| `devbox.json` | `devbox services up -b` | `devbox run --` |
| `.flox/env/manifest.toml` | none | `flox activate -s --` |
| `flake.nix` | none | `nix develop -c` |
| `mise.toml` | none | `mise exec --` |
| none of these | none | none |

The first match wins, so a repo with both `devenv.nix` and `flake.nix` gets devenv. A key in `.eumaeus.toml`
overrides the detected value for that key. Commands are checked against the docs for devenv 2.4.0, devbox
0.18.4, Flox 1.18.1, mise 2026.10.9, and Nix 2.35.3.

- Flox has no `setup`. `flox services start` refuses to run outside an activation, and services stop when the
  last activation exits, so `-s` starts them inside the prefix that wraps the agent.
- Flox documents only multi-user Nix. Step 4 tests it on the single-user install and drops the row if it fails.
- `nix develop` points `TMPDIR` at a fresh directory, and the flake sees only files git tracks.
- `mise exec` installs missing tools before it runs, and has trusted the config it loads since 2026.8.9, so mise
  needs no `setup`.

None of these tools is in the job image. They are installed into the template disk's Nix profile, so every disk
has them from a repo's first job.

## Tools without root: Nix on the disk

devenv, devbox, and Flox sit on Nix. Nix installs into `/nix` as an ordinary user when that user owns `/nix`.
Mounting the disk at `/nix` gives the agent user that ownership with no root at job time.

A fresh volume's root directory is `root:root 0755`, so uid 1000 can't write to it. A volume also starts empty:
`container` doesn't copy the image's files at the mount point into it. So the template disk is made once, by
`scripts/disk.sh template`:

1. `container volume create -s $EUMAEUS_DISK_SIZE eumaeus-template`.
2. One VM as `--user root` runs `chown agent:agent /nix`.
3. One VM as `agent` runs the official Nix installer with `--no-daemon`. `/nix` already belongs to `agent`,
   so the installer never calls `sudo`, which the image doesn't have. The same VM then runs
   `nix profile install` for devenv, devbox, and mise from nixpkgs, and for Flox from `github:flox/flox/latest`,
   which isn't in nixpkgs.
4. The volume's image file is copied to `$EUMAEUS_DATA/disks/template.img` and the volume is removed.

The installer's shell hooks land in the template VM's home directory, which is discarded. The job image sets
`PATH` to the Nix profile on the disk and ships `/etc/nix/nix.conf` with flakes enabled instead.

Without a template disk, the dispatcher logs that and runs jobs with no disk, as today.

## Keeping it between jobs: clone, run, promote

An APFS clone (`cp -c`) of a volume's image file took 4 ms. The clone mounted in a new VM with the original's
files intact. A 2 GB volume holding one file used 2.4 MB on the host, because the image file is sparse.

Each job:

1. `container volume create -s $EUMAEUS_DISK_SIZE eumaeus-<job id>`.
2. Read the volume's image path from `container volume inspect`, field `configuration.source`.
3. `cp -c` the golden disk over that path, or the template disk when the repo has no golden disk yet.
4. Start the VM with `-v eumaeus-<job id>:/nix`.
5. After exit, if `job.sh`'s result line has `"setup_ok": true` and the job wasn't cancelled or timed out:
   `cp -c` the job's image to `<golden>.tmp`, then `mv` it over the golden disk. The rename is atomic, so a job
   starting at that moment clones either the old disk or the new one. A VM killed before it prints a result
   line never promotes.
6. `container volume rm eumaeus-<job id>` on every exit path, the way `removeVm` runs today. `recover()` also
   removes leftover `eumaeus-*` volumes after a dispatcher restart.

Every job writes to its own clone, so no disk is attached to two VMs.

### Cache paths

Before `setup` runs, `job.sh` replaces each `cache` path with a link into the disk:

- `target` becomes a link to `/nix/eumaeus/cache/repo/target`.
- `~/.cargo` becomes a link to `/nix/eumaeus/cache/home/.cargo`.

`~/.cache` is always linked. pip, Go, and other tools that follow XDG keep their caches with no `cache` entry.
Links are generic: eumaeus doesn't need to know `CARGO_TARGET_DIR` or any other tool's variable.

## What this costs

- The README says nothing from the VM survives except the pushed branch. After M5, the disk of every job
  whose `setup` worked also survives. A job can leave anything on its repo's disk, including a modified tool, and the next job on
  that repo runs it. Disks are per repo, so nothing crosses repos. The MCP tool `reset_cache(repo)` deletes a
  repo's golden disk.
- Host disk use only grows. ext4 doesn't return freed blocks to the sparse file, and nothing runs
  `nix-collect-garbage`. `reset_cache` is the M5 answer.
- Cloning depends on a volume being a plain image file on the host. That is how `container` 1.5.0 stores
  volumes, not a documented interface. If `configuration.source` is missing or `cp -c` fails, the job runs
  with no disk and the log says why.
- `job_status` gains an `env` field: which rule set `setup` and `shell` (`.eumaeus.toml`, a detected file,
  or `none`), where the disk came from (`golden`, `template`, or `none`), and how many seconds `setup` took.

## Edge cases

- Two jobs on one repo both succeed. Both promote, the later one wins, and the earlier one's additions are
  lost. The next job still starts on a disk with everything the later job built.
- `setup` exits non-zero. The job ends `failed` with error `setup_exit_<n>` before the agent starts, and the
  disk is not promoted.
- The agent fails after `setup` worked. The disk is promoted with whatever the agent built or broke.
  `reset_cache` clears a disk that went bad.
- The `shell` prefix puts the repo's tools first on `PATH`, including its `node`. The agent CLIs are npm
  packages built for the image's Node 24. `job.sh` resolves their absolute paths and starts them with
  `/usr/local/bin/node` before entering the shell, so a repo pinned to an older Node can't break the agent.
- A `cache` path inside the repo is added to `.git/info/exclude`, so `job.sh` never commits the link.
- `EUMAEUS_DISK_SIZE` applies to disks created after it changes. A repo picks up a new size after
  `reset_cache`.
- A job that times out or is cancelled is not promoted, and its volume is removed.

## Steps

Each step is one commit, checked before the next starts.

Fixtures live in a public repo, `eumaeus-fixtures`, with one branch per row of the filename table and one for
the Rust and Postgres check below.

1. **Base image.** Add `xz-utils`, `/etc/nix/nix.conf` with flakes enabled, `PATH` entries for the disk's
   Nix profile, and a `/nix` mount point. Check: `pnpm smoke <owner/repo>` passes.
2. **Template disk.** `scripts/disk.sh template` builds `template.img`; `setup-mac.sh` calls it. Check: a VM
   on a clone of the template runs `nix run nixpkgs#hello` and `devenv version`. The same check settles whether
   the Nix build sandbox runs in a `container` VM; if it doesn't, `/etc/nix/nix.conf` sets `sandbox = false`.
3. **Clone, mount, promote.** `runner.ts` creates and clones the volume, `jobs.ts` promotes when the result
   has `setup_ok` and removes the volume on every exit, `recover()` sweeps `eumaeus-*` volumes. Check: a second
   `shell` job reads a file the first one wrote under `/nix/eumaeus/cache`, and a file written by a cancelled
   job is gone.
4. **Setup, shell, cache.** `job.sh` reads `SETUP`, `SHELL_PREFIX`, and `CACHE` from the environment, falls
   back to the filename table when they're unset, runs `setup`, links cache paths, wraps the agent, and adds
   `setup_ok` to its result line. Check: on each row's fixture branch, a job runs a tool only that file
   provides.
5. **`.eumaeus.toml`.** The dispatcher fetches and parses it (`smol-toml`) and passes the keys to the VM.
   `job_status` shows `env`. New MCP tool `reset_cache(repo)`.
6. **README.** New section on environments. Limits updated for the surviving disk, disk growth, and the
   dependency on `container`'s volume layout.

## Done when

On the fixture branch whose `flake.nix` provides Rust and Postgres and whose `.eumaeus.toml` `setup` starts
Postgres:

- An agent job runs `cargo test` against Postgres inside the VM, and `job_logs` shows the run.
- The second job's `setup` plus first `cargo test` take under 25% of the first job's. Both times are in the
  log.
- Two jobs submitted together both reach `pushed`.
- A job stopped by `cancel_job` leaves the golden disk's modification time unchanged.
- A job whose agent exits non-zero after `setup` updates it.
- `pnpm smoke <owner/repo>` passes against a repo that declares nothing.

## Not in M5

- A repo image for packages Nix doesn't cover, planned for M6. `image = "<Dockerfile>"` would build on the
  job image through `ARG BASE` and `FROM $BASE`. A Dockerfile `FROM eumaeus-job:dev` with one `RUN` built in
  31 s, most of it starting the builder VM.
- `devcontainer.json` features and Compose services, which assume Docker.
- Garbage collection of disks or the Nix store.
- Sharing a disk between repos.

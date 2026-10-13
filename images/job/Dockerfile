# eumaeus job image: one disposable VM per job.
# Contents: Debian bookworm, Node 24, git, gh, ripgrep, jq, and four agents:
# Claude Code (claude), Codex CLI (codex), Antigravity CLI (agy), pi.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq ripgrep openssh-client \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && npm cache clean --force

# The node image ships uid 1000 as "node"; rename it to "agent".
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
 && mkdir -p /work && chown agent:agent /work

# Nix lives on the repo's disk, mounted at /nix (docs/m5-environments.md); scripts/disk.ts installs it there.
# The image carries the installer's one missing dependency (xz), the config, and the PATH entry. sandbox = false:
# single-user Nix in the VM reports "the prerequisite namespaces are not available" and builds unsandboxed anyway.
RUN apt-get update && apt-get install -y --no-install-recommends xz-utils && rm -rf /var/lib/apt/lists/* \
 && mkdir -m 0755 /nix && chown agent:agent /nix \
 && mkdir -p /etc/nix && printf 'experimental-features = nix-command flakes\nsandbox = false\n' > /etc/nix/nix.conf
# FLOX_DISABLE_METRICS and DO_NOT_TRACK: no usage metrics from job VMs.
ENV USER=agent NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt FLOX_DISABLE_METRICS=true DO_NOT_TRACK=1

USER agent
# Antigravity CLI installs itself into ~/.local/bin. The server gzips the script without a header.
# Headless agy needs the Gemini API key provider selected in settings; the key arrives per job as GEMINI_API_KEY.
RUN curl -fsSL --compressed https://antigravity.google/cli/install.sh | bash \
 && mkdir -p /home/agent/.gemini/antigravity-cli \
 && echo '{"modelProvider":"gemini"}' > /home/agent/.gemini/antigravity-cli/settings.json
# Last on PATH: the disk's tool profile (nix, devenv, devbox, mise) never shadows what the image ships.
ENV PATH="/home/agent/.local/bin:${PATH}:/nix/var/nix/profiles/eumaeus/bin"
# The repo commit this image was built from. scripts/build-image.sh passes it; job.sh logs it.
ARG COMMIT=unknown
ENV EUMAEUS_COMMIT=$COMMIT
# Last: job.sh changes often and must not invalidate the layers above.
COPY --chmod=0755 job.sh /usr/local/bin/job
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/job"]

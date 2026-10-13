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

USER agent
# Antigravity CLI installs itself into ~/.local/bin. The server gzips the script without a header.
# Headless agy needs the Gemini API key provider selected in settings; the key arrives per job as GEMINI_API_KEY.
RUN curl -fsSL --compressed https://antigravity.google/cli/install.sh | bash \
 && mkdir -p /home/agent/.gemini/antigravity-cli \
 && echo '{"modelProvider":"gemini"}' > /home/agent/.gemini/antigravity-cli/settings.json
ENV PATH="/home/agent/.local/bin:${PATH}"
# The repo commit this image was built from. scripts/build-image.sh passes it; job.sh logs it.
ARG COMMIT=unknown
ENV EUMAEUS_COMMIT=$COMMIT
# Last: job.sh changes often and must not invalidate the layers above.
COPY --chmod=0755 job.sh /usr/local/bin/job
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/job"]

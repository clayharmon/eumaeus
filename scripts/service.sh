#!/usr/bin/env bash
# Manage the launchd agent for the dispatcher.
# Usage: scripts/service.sh install|uninstall|restart|status|logs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="me.clayharmon.eumaeus"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/eumaeus"
CONF_DIR="$HOME/.config/eumaeus"
ENV_FILE="$CONF_DIR/dispatcher.env"
DOMAIN="gui/$(id -u)"

ensure_env_file() {
  mkdir -p "$CONF_DIR" && chmod 700 "$CONF_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    {
      echo "# eumaeus dispatcher settings. Read by scripts/dispatcher.sh. Values here override src/config.ts defaults."
      echo "EUMAEUS_AUTH_TOKEN=$(openssl rand -hex 24)"
      echo "# EUMAEUS_MAX_CONCURRENT=2"
      echo "# EUMAEUS_CPUS=4"
      echo "# EUMAEUS_MEMORY=4G"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "wrote $ENV_FILE with a new EUMAEUS_AUTH_TOKEN"
  fi
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$ROOT/scripts/dispatcher.sh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$ROOT</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>30</integer>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>StandardOutPath</key>
	<string>$LOG_DIR/dispatcher.log</string>
	<key>StandardErrorPath</key>
	<string>$LOG_DIR/dispatcher.log</string>
</dict>
</plist>
PL
}

case "${1:-}" in
  install)
    ensure_env_file
    write_plist
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "installed $LABEL ($PLIST); logs: $LOG_DIR/dispatcher.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted $LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state =|pid =|last exit' || echo "$LABEL is not loaded"
    curl -fsS "http://127.0.0.1:${EUMAEUS_PORT:-7777}/healthz" 2>/dev/null && echo || echo "healthz: not responding"
    ;;
  logs)
    tail -n "${2:-50}" "$LOG_DIR/dispatcher.log"
    ;;
  *)
    echo "usage: $0 install|uninstall|restart|status|logs [n]" >&2; exit 2
    ;;
esac

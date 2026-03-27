#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$REPO_DIR/config/runtime.json"

prompt_default() {
  local prompt="$1"
  local default_value="$2"
  local answer
  read -r -p "$prompt [$default_value]: " answer
  if [[ -z "$answer" ]]; then
    answer="$default_value"
  fi
  printf '%s' "$answer"
}

write_service_file() {
  local service_path="$1"
  local service_user="$2"
  local node_bin="$3"

  cat > "$service_path" <<EOF
[Unit]
Description=Float Bubble Room
After=network.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$REPO_DIR
ExecStart=$node_bin $REPO_DIR/server/index.js --config $CONFIG_PATH
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
}

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 18 or newer is required.\n' >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required.\n' >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  printf 'Node.js 18 or newer is required.\n' >&2
  exit 1
fi

printf '\nFloat Bubble Room installer\n\n'

PUBLIC_HOSTNAME="$(prompt_default 'Public hostname' 'localhost')"
PORT="$(prompt_default 'Port' '3000')"
SERVICE_USER="${SUDO_USER:-$USER}"
PUBLIC_BASE_URL="http://$PUBLIC_HOSTNAME:$PORT"

mkdir -p "$REPO_DIR/config"

printf '\nInstalling dependencies...\n'
npm install --omit=dev

printf 'Writing runtime config...\n'
node "$REPO_DIR/scripts/init-config.js" \
  --output "$CONFIG_PATH" \
  --hostname "$PUBLIC_HOSTNAME" \
  --port "$PORT"

NODE_BIN="$(command -v node)"
SERVICE_NAME="float.service"
SERVICE_TARGET="/etc/systemd/system/$SERVICE_NAME"
SERVICE_TEMP="$(mktemp)"
write_service_file "$SERVICE_TEMP" "$SERVICE_USER" "$NODE_BIN"

if command -v systemctl >/dev/null 2>&1; then
  if [[ "$EUID" -eq 0 ]]; then
    install -m 0644 "$SERVICE_TEMP" "$SERVICE_TARGET"
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
    printf '\nInstalled and started %s.\n' "$SERVICE_NAME"
  elif command -v sudo >/dev/null 2>&1; then
    sudo install -m 0644 "$SERVICE_TEMP" "$SERVICE_TARGET"
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE_NAME"
    printf '\nInstalled and started %s with sudo.\n' "$SERVICE_NAME"
  else
    printf '\nCreated %s but could not install it automatically because sudo is unavailable.\n' "$SERVICE_TEMP"
    printf 'Copy it into %s as root, then run systemctl daemon-reload && systemctl enable --now %s\n' "$SERVICE_TARGET" "$SERVICE_NAME"
    exit 0
  fi
else
  printf '\nsystemd was not detected.\n'
  printf 'You can still run the app with:\n'
  printf '  node %s/server/index.js --config %s\n' "$REPO_DIR" "$CONFIG_PATH"
  exit 0
fi

rm -f "$SERVICE_TEMP"

printf '\nFloat is listening with config at %s\n' "$CONFIG_PATH"
printf 'Share URL: %s\n' "$PUBLIC_BASE_URL"
printf 'First-run onboarding in the browser will create the shared password.\n'
printf 'For public exposure, place Float behind HTTPS with a reverse proxy.\n'

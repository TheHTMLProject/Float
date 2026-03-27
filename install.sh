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

prompt_password() {
  local first
  local second

  while true; do
    read -r -s -p "Shared room password: " first
    printf '\n'
    read -r -s -p "Confirm password: " second
    printf '\n'

    if [[ -z "$first" ]]; then
      printf 'Password cannot be empty.\n' >&2
      continue
    fi

    if [[ "$first" != "$second" ]]; then
      printf 'Passwords did not match. Try again.\n' >&2
      continue
    fi

    printf '%s' "$first"
    return 0
  done
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

BIND_HOST="$(prompt_default 'Bind host' '0.0.0.0')"
PORT="$(prompt_default 'Port' '3000')"
PUBLIC_BASE_URL="$(prompt_default 'Public base URL (blank allowed)' '')"
if [[ -z "$PUBLIC_BASE_URL" ]]; then
  PUBLIC_BASE_URL=""
fi
STORAGE_PATH="$(prompt_default 'Storage path' "$REPO_DIR/storage")"
SERVICE_USER="$(prompt_default 'systemd service user' "${SUDO_USER:-$USER}")"
PASSWORD="$(prompt_password)"

mkdir -p "$REPO_DIR/config"

printf '\nInstalling dependencies...\n'
npm install --omit=dev

printf 'Writing runtime config...\n'
FLOAT_PASSWORD="$PASSWORD" node "$REPO_DIR/scripts/init-config.js" \
  --output "$CONFIG_PATH" \
  --bind-host "$BIND_HOST" \
  --port "$PORT" \
  --public-base-url "$PUBLIC_BASE_URL" \
  --storage-path "$STORAGE_PATH"

unset PASSWORD

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
if [[ -n "$PUBLIC_BASE_URL" ]]; then
  printf 'Share URL: %s\n' "$PUBLIC_BASE_URL"
else
  DISPLAY_HOST="$BIND_HOST"
  if [[ "$DISPLAY_HOST" == "0.0.0.0" ]]; then
    DISPLAY_HOST="localhost"
  fi
  printf 'Share URL: http://%s:%s\n' "$DISPLAY_HOST" "$PORT"
fi
printf 'For public exposure, place Float behind HTTPS with a reverse proxy.\n'

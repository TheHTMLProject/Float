#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="float.service"

restart_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'systemd not detected. Restart the app manually if it is running without systemd.\n'
    return 0
  fi

  if systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1; then
    if [[ "$EUID" -eq 0 ]]; then
      systemctl daemon-reload
      systemctl restart "$SERVICE_NAME"
      systemctl status "$SERVICE_NAME" --no-pager --lines=5
      return 0
    fi

    if command -v sudo >/dev/null 2>&1; then
      sudo systemctl daemon-reload
      sudo systemctl restart "$SERVICE_NAME"
      sudo systemctl status "$SERVICE_NAME" --no-pager --lines=5
      return 0
    fi

    printf 'Found %s but could not restart it automatically because sudo is unavailable.\n' "$SERVICE_NAME"
    return 0
  fi

  printf 'No %s unit was found. If you run Float manually, restart it yourself.\n' "$SERVICE_NAME"
}

printf '\nApplying Float updates in %s\n\n' "$REPO_DIR"

cd "$REPO_DIR"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js and npm are required.\n' >&2
  exit 1
fi

printf 'Installing production dependencies...\n'
npm install --omit=dev

printf 'Running automated checks...\n'
npm test

printf 'Restarting the service if present...\n'
restart_service

printf '\nFloat update complete.\n'

#!/usr/bin/env bash
set -euo pipefail

# Sync refreshed Google Drive OAuth token to EC2 and restart app.
# Usage examples:
#   ./scripts/syncDriveTokenToEc2.sh
#   ./scripts/syncDriveTokenToEc2.sh --authorize --verify
#   ./scripts/syncDriveTokenToEc2.sh --host ec2-1-2-3-4.compute.amazonaws.com

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${ROOT_DIR}/.." && pwd)"

HOST="ec2-13-51-85-200.eu-north-1.compute.amazonaws.com"
USER="ubuntu"
PEM_PATH="${ROOT_DIR}/crm.pem"
LOCAL_TOKEN_PATH="${ROOT_DIR}/google-token.json"
REMOTE_APP_DIR="/var/www/express-app"
REMOTE_TOKEN_PATH="${REMOTE_APP_DIR}/google-token.json"

DO_AUTHORIZE=0
DO_VERIFY=0

print_help() {
  cat <<'EOF'
Sync Google Drive OAuth token to EC2.

Options:
  --authorize            Run local Drive auth first (npm run authorize:drive)
  --verify               Run remote npm run ingest:drive after restart
  --host <hostname>      EC2 hostname (default is current production host)
  --user <username>      SSH username (default: ubuntu)
  --pem <path>           Path to SSH key (default: backend/crm.pem)
  --local-token <path>   Local token file path (default: backend/google-token.json)
  --remote-dir <path>    Remote app directory (default: /var/www/express-app)
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --authorize)
      DO_AUTHORIZE=1
      shift
      ;;
    --verify)
      DO_VERIFY=1
      shift
      ;;
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --user)
      USER="${2:-}"
      shift 2
      ;;
    --pem)
      PEM_PATH="${2:-}"
      shift 2
      ;;
    --local-token)
      LOCAL_TOKEN_PATH="${2:-}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_APP_DIR="${2:-}"
      REMOTE_TOKEN_PATH="${REMOTE_APP_DIR}/google-token.json"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo
      print_help
      exit 1
      ;;
  esac
done

if [[ ! -f "${PEM_PATH}" ]]; then
  echo "Missing SSH key: ${PEM_PATH}"
  exit 1
fi

if [[ ${DO_AUTHORIZE} -eq 1 ]]; then
  echo "Running local Google Drive authorization..."
  (
    cd "${ROOT_DIR}"
    npm run authorize:drive
  )
fi

if [[ ! -f "${LOCAL_TOKEN_PATH}" ]]; then
  echo "Missing local token: ${LOCAL_TOKEN_PATH}"
  exit 1
fi

chmod 600 "${PEM_PATH}"

echo "Uploading token to ${USER}@${HOST}:${REMOTE_TOKEN_PATH}"
scp -i "${PEM_PATH}" "${LOCAL_TOKEN_PATH}" "${USER}@${HOST}:${REMOTE_TOKEN_PATH}"

echo "Applying remote permissions and restarting app..."
ssh -i "${PEM_PATH}" "${USER}@${HOST}" "bash -s" <<EOF
set -euo pipefail
chmod 600 "${REMOTE_TOKEN_PATH}"
cd "${REMOTE_APP_DIR}"

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart all
elif systemctl list-unit-files | rg -q '^express-app\.service'; then
  sudo systemctl restart express-app
else
  echo "No pm2 or express-app systemd service found. Restart manually."
fi
EOF

if [[ ${DO_VERIFY} -eq 1 ]]; then
  echo "Running remote ingest verification..."
  ssh -i "${PEM_PATH}" "${USER}@${HOST}" "cd \"${REMOTE_APP_DIR}\" && npm run ingest:drive"
fi

echo "Done. Token sync completed."

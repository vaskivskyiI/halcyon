#!/usr/bin/env bash
# Halcyon installer for Ubuntu 22.04 / 24.04 servers.
#
#   sudo ./deploy/install-ubuntu.sh [--domain mail.example.com --email admin@example.com] [--with-ollama] [--port 8080]
#
# Installs Node.js 22, copies Halcyon to /opt/halcyon, builds the web UI, creates a systemd service,
# optionally configures nginx + Let's Encrypt TLS and a local Ollama with recommended models.
set -euo pipefail

DOMAIN="" ; LE_EMAIL="" ; WITH_OLLAMA=0 ; PORT=8080
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) LE_EMAIL="$2"; shift 2 ;;
    --with-ollama) WITH_OLLAMA=1; shift ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Please run as root (sudo)."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/halcyon
DATA=/var/lib/halcyon
ENVFILE=/etc/halcyon/halcyon.env

echo "==> Installing system packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg rsync

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "==> Installing Node.js 22"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q nodejs
fi

echo "==> Creating user and directories"
id halcyon >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin halcyon
mkdir -p "$APP" "$DATA" /etc/halcyon
rsync -a --delete --exclude node_modules --exclude .git --exclude 'desktop/out' --exclude 'desktop/server-bundle' --exclude data "$SRC/" "$APP/"

echo "==> Installing dependencies and building the web UI"
cd "$APP"
npm ci --no-audit --no-fund -w server -w web
npm run build -w web
npm prune --omit=dev -w server >/dev/null 2>&1 || true
chown -R halcyon:halcyon "$DATA"

if [[ ! -f "$ENVFILE" ]]; then
  echo "==> Writing $ENVFILE"
  cat > "$ENVFILE" <<CONF
# Halcyon configuration — see README for all options.
HALCYON_HOST=127.0.0.1
HALCYON_PORT=$PORT
HALCYON_DATA_DIR=$DATA
# Master key for encrypting stored passwords/API keys. Keep it secret and back it up with the data dir.
HALCYON_SECRET=$(openssl rand -base64 32)
HALCYON_PUBLIC_URL=${DOMAIN:+https://$DOMAIN}
HALCYON_SECURE_COOKIES=${DOMAIN:+1}
HALCYON_ALLOW_SIGNUP=0
# Optional OAuth for Gmail / Microsoft 365 (redirect URI: <public url>/api/oauth/callback)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
CONF
  chmod 640 "$ENVFILE"; chown root:halcyon "$ENVFILE"
fi

echo "==> Installing systemd service"
install -m 644 "$APP/deploy/halcyon.service" /etc/systemd/system/halcyon.service
systemctl daemon-reload
systemctl enable --now halcyon
systemctl restart halcyon

if [[ -n "$DOMAIN" ]]; then
  echo "==> Configuring nginx for $DOMAIN"
  apt-get install -y -q nginx certbot python3-certbot-nginx
  sed -e "s/mail.example.com/$DOMAIN/g" -e "s/127.0.0.1:8080/127.0.0.1:$PORT/g" "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/halcyon
  ln -sf /etc/nginx/sites-available/halcyon /etc/nginx/sites-enabled/halcyon
  nginx -t && systemctl reload nginx
  if [[ -n "$LE_EMAIL" ]]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
  else
    echo "   (skip TLS: pass --email to obtain a Let's Encrypt certificate)"
  fi
fi

if [[ $WITH_OLLAMA -eq 1 ]]; then
  echo "==> Installing Ollama and pulling recommended models"
  command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
  systemctl enable --now ollama
  sleep 3
  ollama pull llama3.1:8b
  ollama pull nomic-embed-text
  echo "   In Halcyon: Settings → AI → Add provider → Ollama (this machine)."
fi

echo
echo "Halcyon is running."
if [[ -n "$DOMAIN" ]]; then echo "Open https://$DOMAIN to create the administrator account."; else echo "Open http://<server>:$PORT (or put it behind nginx: deploy/nginx.conf). Note: it listens on 127.0.0.1 by default — set HALCYON_HOST=0.0.0.0 in $ENVFILE to expose it directly."; fi
echo "Logs: journalctl -u halcyon -f    Config: $ENVFILE    Data: $DATA"

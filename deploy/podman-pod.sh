#!/usr/bin/env bash
# Run Halcyon as a Podman pod (rootless or root): one pod with the Halcyon container and, optionally, Ollama.
# Containers in a pod share localhost, so Halcyon reaches Ollama at http://127.0.0.1:11434 and that
# endpoint counts as "local" for Privacy mode. Only Halcyon's port is published.
#
#   ./deploy/podman-pod.sh up        [--port 8080] [--bind 127.0.0.1] [--with-ollama] [--gpu] [--models "qwen2.5:7b-instruct nomic-embed-text"]
#   ./deploy/podman-pod.sh build     rebuild the image from this checkout
#   ./deploy/podman-pod.sh update    git pull, rebuild and recreate the pod with the options of the last 'up'
#                                    (data volumes are kept; --no-pull skips git pull; options given here override)
#   ./deploy/podman-pod.sh down      stop and remove the pod (data volumes are kept)
#   ./deploy/podman-pod.sh logs      follow Halcyon's log
#   ./deploy/podman-pod.sh status    show pod, containers and health
#   ./deploy/podman-pod.sh systemd   install a user systemd unit so the pod starts at boot (rootless: also run
#                                    `loginctl enable-linger $USER` once)
#
# Configuration: deploy/halcyon.env (created on first run, mode 600). It holds HALCYON_SECRET — the key that
# encrypts stored mail/AI credentials. Back it up together with the halcyon-data volume; losing it makes
# stored passwords unreadable.
#
# By default the port is bound to 127.0.0.1: put nginx/Caddy with TLS in front (deploy/nginx.conf) and set
# HALCYON_PUBLIC_URL, HALCYON_SECURE_COOKIES=1 in halcyon.env. Use --bind 0.0.0.0 only on a trusted network.
set -euo pipefail

POD=halcyon
IMAGE=localhost/halcyon:latest
OLLAMA_IMAGE=docker.io/ollama/ollama:0.40.6
PORT=8080 ; BIND=127.0.0.1 ; WITH_OLLAMA=0 ; GPU=0 ; MODELS="qwen2.5:7b-instruct nomic-embed-text"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$SRC/deploy/halcyon.env"
OPTFILE="$SRC/deploy/pod.options"   # options of the last 'up', reused by 'update' (git-ignored)
PULL=1

cmd="${1:-help}"; shift || true
ARGS=("$@")
# shellcheck disable=SC1090
[[ "$cmd" == update && -f "$OPTFILE" ]] && source "$OPTFILE"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --with-ollama) WITH_OLLAMA=1; shift ;;
    --gpu) GPU=1; shift ;;
    --models) MODELS="$2"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

command -v podman >/dev/null || { echo "podman is not installed (sudo apt install podman)"; exit 1; }

ensure_env() {
  [[ -f "$ENVFILE" ]] && return
  umask 077
  cat > "$ENVFILE" <<EOF
# Halcyon container configuration (see server/src/config.js for all options).
HALCYON_SECRET=$(head -c 32 /dev/urandom | base64)
# Public https URL when behind a reverse proxy (needed for OAuth redirects), and secure cookies with TLS:
HALCYON_PUBLIC_URL=
HALCYON_SECURE_COOKIES=0
# Inside the pod the reverse proxy is not on loopback; set its address if it adds X-Forwarded-For.
HALCYON_TRUST_PROXY=
HALCYON_ALLOW_SIGNUP=0
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
EOF
  echo "==> Created $ENVFILE (back it up: it contains the encryption key)"
}

build() {
  echo "==> Building $IMAGE"
  podman build -t "$IMAGE" -f "$SRC/Dockerfile" "$SRC"
}

up() {
  ensure_env
  podman image exists "$IMAGE" || build
  if podman pod exists "$POD"; then echo "Pod $POD already exists — use '$0 update' or '$0 down' first."; exit 1; fi
  podman volume exists halcyon-data || podman volume create halcyon-data >/dev/null
  echo "==> Creating pod $POD on $BIND:$PORT"
  printf 'PORT=%q\nBIND=%q\nWITH_OLLAMA=%q\nGPU=%q\n' "$PORT" "$BIND" "$WITH_OLLAMA" "$GPU" > "$OPTFILE"
  podman pod create --name "$POD" -p "$BIND:$PORT:8080"
  if [[ $WITH_OLLAMA -eq 1 ]]; then
    podman volume exists ollama-models || podman volume create ollama-models >/dev/null
    local gpu=()
    [[ $GPU -eq 1 ]] && gpu=(--device nvidia.com/gpu=all --security-opt=label=disable)
    podman run -d --pod "$POD" --name "$POD-ollama" --restart unless-stopped "${gpu[@]}" \
      -v ollama-models:/root/.ollama -e OLLAMA_KEEP_ALIVE=30m "$OLLAMA_IMAGE"
  fi
  # The container runs in the host's time zone (else UTC): server-side defaults, reminders and the daily brief use it.
  local tz="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')}"
  echo "==> Time zone: ${tz:-UTC}"
  # :U chowns the volume to the container user (node, uid 1000) under rootless user namespaces.
  podman run -d --pod "$POD" --name "$POD-app" --restart unless-stopped \
    --env-file "$ENVFILE" -e TZ="${tz:-UTC}" -v halcyon-data:/data:U,Z \
    --health-cmd "node -e \"fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
    --health-interval 30s "$IMAGE"
  if [[ $WITH_OLLAMA -eq 1 && -n "$MODELS" ]]; then
    echo "==> Pulling models: $MODELS (first time can take a while)"
    for i in {1..30}; do podman exec "$POD-ollama" ollama list >/dev/null 2>&1 && break; sleep 1; done
    for m in $MODELS; do podman exec "$POD-ollama" ollama pull "$m"; done
  fi
  echo
  # Report what actually happened instead of assuming success.
  local ok=0
  for i in {1..30}; do
    podman exec "$POD-app" node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && { ok=1; break; }
    podman container inspect -f '{{.State.Running}}' "$POD-app" 2>/dev/null | grep -q true || break
    sleep 1
  done
  if [[ $ok -ne 1 ]]; then
    echo "Halcyon did not start. Last log lines:"
    podman logs --tail 30 "$POD-app"
    exit 1
  fi
  echo "Halcyon is running: http://$BIND:$PORT"
  if [[ "$BIND" == 127.* ]]; then
    echo "Note: bound to $BIND — reachable only from this server (e.g. nginx on the host → proxy_pass http://127.0.0.1:$PORT)."
    echo "      For a proxy in a container or access from other machines, recreate with --bind 0.0.0.0 (or this host's LAN IP)."
  fi
  [[ $WITH_OLLAMA -eq 1 ]] && echo "In Settings → AI add provider 'Ollama (this machine)' with URL http://127.0.0.1:11434"
  return 0
}

down() {
  podman pod exists "$POD" || { echo "Pod $POD does not exist"; return; }
  podman pod stop "$POD" >/dev/null && podman pod rm "$POD"
  echo "Pod removed; volumes halcyon-data / ollama-models are kept."
}

with_ollama_flag() { podman container exists "$POD-ollama" && WITH_OLLAMA=1 && MODELS="" || true; }

case "$cmd" in
  up) up ;;
  build) build ;;
  update)
    if [[ $PULL -eq 1 ]]; then
      if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
        echo "==> git pull"
        git -C "$SRC" pull --ff-only || { echo "git pull failed (local changes or diverged branch?) — fix it, or run '$0 update --no-pull'."; exit 1; }
        # The pull may have changed this script; continue with the new version.
        exec "$SRC/deploy/podman-pod.sh" update --no-pull "${ARGS[@]}"
      else
        echo "Not a git checkout — skipping git pull."
      fi
    fi
    with_ollama_flag
    build; down; up ;;
  down) down ;;
  logs) podman logs -f "$POD-app" ;;
  status)
    podman pod ps --filter name="$POD"; podman ps --pod --filter pod="$POD" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
    echo "Published: $(podman pod inspect "$POD" --format '{{range $k, $v := .InfraConfig.PortBindings}}{{range $v}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' 2>/dev/null)"
    podman exec "$POD-app" node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.text()).then(t=>console.log('Health:', t)).catch(e=>console.log('Health: FAILED', e.message))" 2>/dev/null || echo "Health: app container not running" ;;
  systemd)
    mkdir -p ~/.config/systemd/user
    (cd ~/.config/systemd/user && podman generate systemd --new --files --name "$POD" >/dev/null)
    down
    systemctl --user daemon-reload
    systemctl --user enable --now "pod-$POD.service"
    echo "Installed ~/.config/systemd/user/pod-$POD.service (starts at boot with: loginctl enable-linger $USER)" ;;
  *) sed -n 2,21p "$0" ;;
esac

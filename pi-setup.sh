#!/usr/bin/env bash
# pi-setup.sh — Bootstrap a Raspberry Pi to run the Meticulous MCP HTTP server
#
# Usage:
#   chmod +x pi-setup.sh
#   ./pi-setup.sh
#
# What this installs:
#   - Node.js 20 LTS (via NodeSource)
#   - just  (command runner, replaces make)
#   - cloudflared  (Cloudflare Tunnel client)
#   - npm dependencies + build

set -euo pipefail

# ── colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[setup]${NC} $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
section() { echo -e "\n${GREEN}══ $* ══${NC}"; }

# ── detect arch ───────────────────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) ARCH_LABEL="arm64" ;;
  armv7l)        ARCH_LABEL="armv7" ;;
  x86_64)        ARCH_LABEL="amd64" ;;
  *)             echo -e "${RED}Unsupported architecture: $ARCH${NC}"; exit 1 ;;
esac
info "Detected architecture: $ARCH ($ARCH_LABEL)"

# ── node.js 20 lts ────────────────────────────────────────────────────────────
section "Node.js 20 LTS"
if command -v node &>/dev/null && node --version | grep -q "^v2[0-9]"; then
  info "Node.js $(node --version) already installed — skipping"
else
  info "Installing Node.js 20 LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  info "Node.js $(node --version) installed"
fi

info "npm version: $(npm --version)"

# ── just ──────────────────────────────────────────────────────────────────────
section "just (command runner)"
if command -v just &>/dev/null; then
  info "just $(just --version) already installed — skipping"
else
  info "Installing just..."
  JUST_VERSION=$(curl -s https://api.github.com/repos/casey/just/releases/latest \
    | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')

  # Map arch label to just release naming
  case "$ARCH_LABEL" in
    arm64)  JUST_ARCH="aarch64-unknown-linux-musl" ;;
    armv7)  JUST_ARCH="armv7-unknown-linux-musleabihf" ;;
    amd64)  JUST_ARCH="x86_64-unknown-linux-musl" ;;
  esac

  JUST_URL="https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${JUST_ARCH}.tar.gz"
  info "Downloading just ${JUST_VERSION} for ${JUST_ARCH}..."
  curl -fsSL "$JUST_URL" -o /tmp/just.tar.gz
  tar -xzf /tmp/just.tar.gz -C /tmp just
  sudo mv /tmp/just /usr/local/bin/just
  rm /tmp/just.tar.gz
  info "just $(just --version) installed"
fi

# ── cloudflared ───────────────────────────────────────────────────────────────
section "cloudflared (Cloudflare Tunnel)"
if command -v cloudflared &>/dev/null; then
  info "cloudflared $(cloudflared --version 2>&1 | head -1) already installed — skipping"
else
  info "Installing cloudflared..."
  case "$ARCH_LABEL" in
    arm64) CF_ARCH="arm64" ;;
    armv7) CF_ARCH="arm" ;;
    amd64) CF_ARCH="amd64" ;;
  esac

  CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
  curl -fsSL "$CF_URL" -o /tmp/cloudflared
  sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
  sudo chmod +x /usr/local/bin/cloudflared
  info "cloudflared $(cloudflared --version 2>&1 | head -1) installed"
fi

# ── jq (used by just test recipes) ───────────────────────────────────────────
section "jq"
if command -v jq &>/dev/null; then
  info "jq $(jq --version) already installed — skipping"
else
  sudo apt-get install -y jq
  info "jq $(jq --version) installed"
fi

# ── npm install + build ───────────────────────────────────────────────────────
section "npm install + build"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
info "Working directory: $SCRIPT_DIR"

info "Running npm install..."
npm install

info "Building..."
npm run build

# ── .env reminder ─────────────────────────────────────────────────────────────
section "Environment setup"
if [[ -f ".env" ]]; then
  info ".env file found — good."
else
  warn "No .env file found. Create one before starting the HTTP server:"
  echo ""
  echo "  cat > .env <<EOF"
  echo "  METICULOUS_IP=192.168.x.x"
  echo "  MCP_AUTH_TOKEN=\$(just generate-token)"
  echo "  PORT=3000"
  echo "  EOF"
  echo ""
fi

# ── systemd service reminder ──────────────────────────────────────────────────
section "Next steps"
echo ""
echo "  1. Create .env with your METICULOUS_IP and MCP_AUTH_TOKEN (see above)"
echo ""
echo "  2. Smoke test:"
echo "     just start-http"
echo ""
echo "  3. Run all sanity tests (in a second terminal while server is running):"
echo "     just test"
echo ""
echo "  4. Set up the systemd service — see PI_SETUP_INSTRUCTIONS.md Step 4"
echo "     Then use:  just enable    # first time"
echo "                just deploy    # for future updates"
echo "                just logs      # live logs"
echo ""
echo "  5. Start a Cloudflare tunnel:"
echo "     cloudflared tunnel --url http://localhost:3000"
echo ""
info "Setup complete ✅"

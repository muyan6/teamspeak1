#!/usr/bin/env bash
set -euo pipefail

echo "╔══════════════════════════════════════╗"
echo "║       TSMusicBot Installer           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Resolve script location → project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="/opt/tsmusicbot"
SERVICE_NAME="tsmusicbot"

# Verify we're in a valid project directory
if [ ! -f "$PROJECT_DIR/package.json" ]; then
    echo "Error: Cannot find package.json in $PROJECT_DIR"
    echo "Please run this script from the TSMusicBot project directory."
    exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "Unsupported OS"
    exit 1
fi

echo "[1/6] Installing system dependencies..."
case $OS in
    ubuntu|debian)
        sudo apt-get update -qq
        sudo apt-get install -y -qq curl build-essential python3
        ;;
    centos|rhel|fedora)
        sudo yum install -y curl gcc gcc-c++ make python3
        ;;
    arch|manjaro)
        sudo pacman -S --noconfirm curl base-devel python
        ;;
    *)
        echo "Unsupported OS: $OS. Please install Node.js 20, build tools, and FFmpeg manually."
        ;;
esac

echo "[2/6] Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null || ! node "$SCRIPT_DIR/check-node-version.cjs"; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs 2>/dev/null || sudo yum install -y nodejs 2>/dev/null
fi
node "$SCRIPT_DIR/check-node-version.cjs"
echo "Node.js $(node -v) installed"

echo "[3/6] Installing dependencies..."
cd "$PROJECT_DIR"
npm install
if [ -d "$PROJECT_DIR/web/package.json" ] || [ -f "$PROJECT_DIR/web/package.json" ]; then
    (cd "$PROJECT_DIR/web" && npm install)
fi

echo "[4/6] Building project..."
npm run build

echo "[5/6] Copying to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$PROJECT_DIR/dist" "$INSTALL_DIR/"
sudo cp -r "$PROJECT_DIR/node_modules" "$INSTALL_DIR/"
sudo cp "$PROJECT_DIR/package.json" "$INSTALL_DIR/"
# Copy web frontend if built
if [ -d "$PROJECT_DIR/web/dist" ]; then
    sudo mkdir -p "$INSTALL_DIR/web"
    sudo cp -r "$PROJECT_DIR/web/dist" "$INSTALL_DIR/web/"
fi
# Copy scripts for future use
sudo mkdir -p "$INSTALL_DIR/scripts"
sudo cp -r "$PROJECT_DIR/scripts/"* "$INSTALL_DIR/scripts/" 2>/dev/null || true
# Create data directory
sudo mkdir -p "$INSTALL_DIR/data"

# Run the service as a dedicated unprivileged account. The directory is owned by
# that account because the bot writes config, database, cookies, logs and media
# below the install root at runtime.
if ! id -u "$SERVICE_NAME" >/dev/null 2>&1; then
    NOLOGIN_SHELL="$(command -v nologin || echo /usr/sbin/nologin)"
    sudo useradd --system --home-dir "$INSTALL_DIR" --shell "$NOLOGIN_SHELL" "$SERVICE_NAME"
fi
sudo chown -R "$SERVICE_NAME:$SERVICE_NAME" "$INSTALL_DIR"

echo "[6/6] Creating systemd service..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOL
[Unit]
Description=TSMusicBot - TeamSpeak Music Bot
After=network.target

[Service]
Type=simple
User=${SERVICE_NAME}
Group=${SERVICE_NAME}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${INSTALL_DIR}

[Install]
WantedBy=multi-user.target
EOL

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl start ${SERVICE_NAME}

echo ""
echo "╔══════════════════════════════════════╗"
echo "║    TSMusicBot installed and running! ║"
echo "║                                      ║"
echo "║    WebUI: http://localhost:3000       ║"
echo "║                                      ║"
echo "║    Commands:                          ║"
echo "║    systemctl status tsmusicbot       ║"
echo "║    systemctl restart tsmusicbot      ║"
echo "║    systemctl stop tsmusicbot         ║"
echo "║    journalctl -u tsmusicbot -f       ║"
echo "╚══════════════════════════════════════╝"

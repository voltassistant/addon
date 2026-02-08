#!/bin/bash
# Deploy VoltAssistant to LXC 125 via Proxmox
set -e

PROXMOX="proxmox"
LXC_ID="125"
DEST="/opt/voltassistant"
SRC="/root/clawd/projects/voltassistant"

echo "🚀 Deploying VoltAssistant to LXC $LXC_ID..."

# Stop service
echo "⏹️  Stopping service..."
ssh $PROXMOX "pct exec $LXC_ID -- systemctl stop voltassistant 2>/dev/null || true"

# Copy files via Proxmox
echo "📦 Copying files..."
for dir in src data public; do
  if [ -d "$SRC/$dir" ]; then
    # Create temp tar, copy via ssh, extract in LXC
    tar -C "$SRC" -czf - "$dir" | ssh $PROXMOX "pct exec $LXC_ID -- tar -C $DEST -xzf -"
  fi
done

# Copy package files
for file in package.json package-lock.json tsconfig.json; do
  if [ -f "$SRC/$file" ]; then
    cat "$SRC/$file" | ssh $PROXMOX "pct exec $LXC_ID -- tee $DEST/$file > /dev/null"
  fi
done

# Install dependencies
echo "📥 Installing dependencies..."
ssh $PROXMOX "pct exec $LXC_ID -- bash -c 'cd $DEST && npm install --production=false'"

# Build
echo "🔨 Building..."
ssh $PROXMOX "pct exec $LXC_ID -- bash -c 'cd $DEST && npm run build'"

# Start service
echo "▶️  Starting service..."
ssh $PROXMOX "pct exec $LXC_ID -- systemctl start voltassistant"

# Check status
echo "✅ Checking status..."
sleep 2
ssh $PROXMOX "pct exec $LXC_ID -- systemctl status voltassistant --no-pager" || true

echo ""
echo "🎉 Deploy complete! Test: curl http://192.168.31.73:3001/health"

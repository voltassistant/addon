# ⚡ VoltAssistant

**Smart battery charging optimizer** combining PVPC electricity prices with solar forecast and real-time inverter data from Home Assistant.

[![Node.js](https://img.shields.io/badge/Node.js-22-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Features

### 📊 Smart Planning
- Analyze PVPC prices from ESIOS/REE
- Integrate solar forecast from forecast.solar
- Generate hourly charge/discharge schedules
- Estimate daily savings vs average prices

### 🔋 Real-time Monitoring
- Connect to Home Assistant for live inverter data
- Track battery SOC, solar production, grid power
- Health alerts for low battery or high temperature
- Support for Deye/Solarman inverters

### 🌐 Web Dashboard
- Visual dashboard with auto-refresh
- 24-hour price chart with color coding
- 7-day history with trends
- Current recommendations

### 📱 Notifications
- Daily morning report via WhatsApp
- Battery alerts when SOC is low
- Webhook endpoints for automations

## Quick Start

```bash
# Install
npm install

# CLI mode
npm run dev

# API server
npm run serve
```

## CLI Usage

```bash
# Today's plan
npx ts-node src/index.ts

# Specific date and battery
npx ts-node src/index.ts --date=2024-01-15 --battery=15

# Detailed hourly breakdown
npx ts-node src/index.ts --detailed

# JSON output
npx ts-node src/index.ts --json
```

## API Server

Start with `npm run serve` (default port 3001).

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Visual dashboard |
| `/health` | GET | Health check |
| `/status` | GET | Real-time inverter status from HA |
| `/dashboard` | GET | Combined status + plan + prices |
| `/plan` | GET/POST | Today's charging plan |
| `/prices` | GET | PVPC prices (24h) |
| `/solar` | GET | Solar forecast |
| `/history` | GET | Price/solar history (7 days) |
| `/history/week` | GET | Weekly summary with best windows |
| `/report/daily` | GET | Formatted daily report for notifications |
| `/webhook/ha` | POST | Home Assistant automation webhook |
| `/webhook/notify` | POST | Notification webhook |
| `/summary` | GET | Plain text summary |

### Example: Get Dashboard

```bash
curl http://localhost:3001/dashboard
```

Response:
```json
{
  "success": true,
  "realtime": {
    "battery": { "soc": 20, "state": "charging", "power": 1500 },
    "solar": { "totalPower": 2100, "todayKwh": 6.5 },
    "grid": { "power": -50 }
  },
  "plan": {
    "currentAction": "charge_from_solar",
    "recommendations": ["☀️ Good solar day expected..."],
    "estimatedSavings": 0.35
  },
  "prices": {
    "current": 0.127,
    "cheapestHours": [0, 1, 2, 3, 4, 5]
  }
}
```

## Home Assistant Integration

```bash
# Set environment variables
HA_URL=http://192.168.1.100:8123
HA_TOKEN=your_long_lived_token

# Check connection
npm run ha -- status

# Control inverter
npm run ha -- charge    # Enable grid charging
npm run ha -- discharge # Enable discharge mode
npm run ha -- auto      # Set to self-use mode
```

### Supported Entities

Works with Solarman/Deye inverters:
- `sensor.predbat_battery_soc_2`
- `sensor.inverter_battery_state`
- `sensor.inverter_pv1_voltage`, `pv1_current`, etc.
- `sensor.inverter_grid_power`
- `sensor.inverter_load_l1_power`

## Configuration

Create `.env`:

```bash
# ESIOS API (optional, for real PVPC prices)
ESIOS_TOKEN=your_esios_token

# Home Assistant
HA_URL=http://192.168.31.54:8123
HA_TOKEN=your_long_lived_access_token

# API Server
PORT=3001
API_KEY=optional_api_key
```

## Cron Integration

### OpenClaw

```json
{
  "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Europe/Madrid" },
  "payload": { 
    "kind": "systemEvent", 
    "text": "Get VoltAssistant daily report and send via WhatsApp" 
  }
}
```

### Standard crontab

```bash
# Morning report at 8am
0 8 * * * curl -s http://localhost:3001/report/daily | jq -r '.report'

# Battery check every 2 hours
0 */2 * * * curl -s http://localhost:3001/status | jq -r '.battery.soc'
```

## Deployment

### Proxmox LXC

```bash
# Create Debian 12 LXC (512MB RAM, 4GB disk)
# Install Node.js 22
# Clone and build

[Unit]
Description=VoltAssistant API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/voltassistant
ExecStart=/usr/bin/node dist/server.js
Environment=NODE_ENV=production
Restart=always

[Install]
WantedBy=multi-user.target
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   PVPC API      │     │  Solar Forecast │     │  Home Assistant │
│   (ESIOS/REE)   │     │  (forecast.solar)│     │   (Inverter)    │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────┬───────┴───────────────────────┘
                         │
                  ┌──────▼──────┐
                  │  VoltAssist │
                  │   Engine    │
                  └──────┬──────┘
                         │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
┌───▼───┐         ┌──────▼──────┐      ┌──────▼──────┐
│  CLI  │         │  HTTP API   │      │  Dashboard  │
│       │         │ + Webhooks  │      │   (HTML)    │
└───────┘         └─────────────┘      └─────────────┘
```

## Battery Config

Default (Deye SUN-6K-EU):
- Capacity: 10 kWh
- Max charge rate: 3 kW
- Min SOC: 10%
- Max SOC: 100%

Override via CLI flags or API parameters.

## License

MIT

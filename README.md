# ⚡ VoltAssistant

Smart battery charging optimizer for home energy systems. Combines **PVPC electricity prices** with **solar forecast** to determine the optimal charging strategy.

## Features

- 📊 **PVPC Price Analysis** - Fetches real electricity prices from ESIOS/REE
- ☀️ **Solar Forecast** - Integrates with forecast.solar for production predictions  
- 🔋 **Smart Planning** - Generates hourly charge/discharge schedules
- 💰 **Savings Calculator** - Estimates daily savings vs average prices
- 🏠 **Home Assistant Integration** - Control your inverter automatically
- 🌐 **REST API** - Webhooks for cron jobs and automation

## Quick Start

```bash
# Install dependencies
npm install

# Run CLI
npm run dev

# Run with options
npm run dev -- --date=2024-01-15 --battery=15 --detailed
```

## CLI Options

```
--date=YYYY-MM-DD  Analyze a specific date (default: today)
--battery=10       Battery capacity in kWh (default: 10)
--detailed         Show detailed hourly breakdown
--json             Output plan as JSON
--help, -h         Show help message
```

## API Server

Start the HTTP server for integration with Home Assistant, cron jobs, or other systems:

```bash
# Start server
npm run serve

# Server runs on http://localhost:3001
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/plan` | GET | Get today's charging plan |
| `/plan` | POST | Get plan with custom parameters |
| `/prices` | GET | Get PVPC prices |
| `/solar` | GET | Get solar forecast |
| `/webhook/ha` | POST | Home Assistant webhook |
| `/webhook/notify` | POST | Notification webhook |
| `/summary` | GET | Plain text summary |

### Example: Get Today's Plan

```bash
curl http://localhost:3001/plan
```

Response:
```json
{
  "success": true,
  "plan": {
    "date": "2024-01-15",
    "recommendations": [
      "🔌 Charge from grid during hours 2, 3, 4 (cheapest prices)",
      "☀️ Good solar day expected (8kWh) - prioritize self-consumption",
      "💰 Estimated savings today: €1.50"
    ],
    "gridChargeHours": [2, 3, 4],
    "gridChargeCost": 0.45,
    "solarChargeWh": 6500,
    "savings": 1.50
  }
}
```

### Home Assistant Webhook

For automations, call the `/webhook/ha` endpoint to get the current recommended action:

```bash
curl -X POST http://localhost:3001/webhook/ha
```

Response includes:
- `current_action` - What to do now (charge_from_grid, discharge, etc.)
- `should_charge_from_grid` - Boolean for simple automations
- `is_cheap_hour` / `is_expensive_hour` - Price indicators
- `expected_solar_watts` - Current hour solar forecast

## Home Assistant Integration

Control your Deye inverter (or similar) via Home Assistant:

```bash
# Check connection
npm run ha -- status

# Enable grid charging
npm run ha -- charge

# Enable discharge/selling mode  
npm run ha -- discharge

# Set to auto/self-use mode
npm run ha -- auto
```

### Environment Variables

```env
# ESIOS API (optional, for real PVPC prices)
ESIOS_TOKEN=your_esios_token

# Home Assistant
HA_URL=http://192.168.1.100:8123
HA_TOKEN=your_long_lived_access_token

# API Server
PORT=3001
API_KEY=optional_api_key
```

## Cron Integration

Add to your crontab or OpenClaw cron to get daily plans:

```bash
# Get daily summary at 6am
0 6 * * * curl -s http://localhost:3001/webhook/notify | jq -r '.message'
```

For OpenClaw, create a cron job with:
```json
{
  "schedule": { "kind": "cron", "expr": "0 6 * * *", "tz": "Europe/Madrid" },
  "payload": { "kind": "systemEvent", "text": "Check VoltAssistant daily plan" }
}
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   PVPC API      │     │  Solar Forecast │
│   (ESIOS/REE)   │     │  (forecast.solar)│
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │  Optimizer  │
              │   Engine    │
              └──────┬──────┘
                     │
    ┌────────────────┼────────────────┐
    │                │                │
┌───▼───┐     ┌──────▼──────┐   ┌─────▼─────┐
│  CLI  │     │  HTTP API   │   │ HA Control│
│       │     │             │   │           │
└───────┘     └─────────────┘   └───────────┘
```

## Battery Config

Default configuration (Deye SUN-6K-EU):
- Capacity: 10kWh
- Max charge rate: 3kW
- Min SoC: 10%
- Max SoC: 100%

Adjust via CLI flags or API parameters.

## License

MIT

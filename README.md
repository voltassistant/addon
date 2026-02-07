# ⚡ VoltAssistant

Smart battery charging optimizer combining PVPC electricity prices with solar forecast.

## Features

- 💶 Fetch PVPC electricity prices (Spain)
- ☀️ Solar production forecast
- 🔋 Optimal battery charging strategy
- 💰 Cost savings estimation

## Usage

```bash
npm install
npm run dev

# With options
npm run dev -- --date=2024-01-15 --battery=15 --detailed
```

## Configuration

Create `.env` file:

```bash
ESIOS_TOKEN=your_token    # ESIOS API token (optional)
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your_ha_token
```

## How it works

1. Fetches PVPC prices for the day
2. Gets solar production forecast
3. Calculates optimal charging windows
4. Recommends when to:
   - Charge from grid (cheap hours)
   - Charge from solar
   - Use battery (expensive hours)

## Deye SUN-6K-EU Integration

Coming soon: Direct integration with Deye inverter via ModbusTCP

## License

MIT

# VoltAssistant API Documentation

VoltAssistant is a smart battery charging optimizer for Home Assistant that combines PVPC (Spanish electricity prices) with solar forecasts to minimize energy costs.

## Table of Contents

- [Installation](#installation)
- [Configuration](#configuration)
- [API Reference](#api-reference)
  - [REST Endpoints](#rest-endpoints)
  - [WebSocket Events](#websocket-events)
- [Data Types](#data-types)
- [Examples](#examples)

## Installation

### Home Assistant Add-on

1. Add this repository to your Home Assistant add-on store
2. Install VoltAssistant
3. Configure the add-on (see Configuration)
4. Start the add-on

### Manual Installation

```bash
git clone https://github.com/voltassistant/addon.git
cd addon/voltassistant
npm install
npm run build
npm start
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HA_URL` | Home Assistant URL | `http://supervisor/core` |
| `HA_TOKEN` | Long-lived access token | (required) |
| `PVPC_TARIFF` | PVPC tariff (2.0TD, 3.0TD) | `2.0TD` |
| `BATTERY_CAPACITY` | Battery capacity in Wh | `10000` |
| `MAX_CHARGE_RATE` | Max charge rate in W | `3000` |
| `MIN_SOC` | Minimum state of charge | `0.1` |
| `MAX_SOC` | Maximum state of charge | `1.0` |
| `LATITUDE` | Location latitude | (auto from HA) |
| `LONGITUDE` | Location longitude | (auto from HA) |

### Example Configuration (YAML)

```yaml
battery:
  capacity_wh: 10000
  max_charge_rate_w: 3000
  min_soc: 0.1
  max_soc: 1.0
  
pvpc:
  tariff: "2.0TD"
  
solar:
  panels_wp: 6000
  orientation: 180  # South
  tilt: 30
  
home_assistant:
  url: "http://supervisor/core"
  token: "your-long-lived-access-token"
  
sensors:
  battery_soc: "sensor.battery_soc"
  solar_power: "sensor.solar_power"
  grid_power: "sensor.grid_power"
```

## API Reference

### REST Endpoints

#### GET /api/status

Returns the current system status.

**Response:**
```json
{
  "status": "running",
  "version": "1.0.0",
  "lastUpdate": "2024-02-15T10:30:00Z",
  "battery": {
    "soc": 0.65,
    "capacityWh": 10000,
    "powerW": 1500
  },
  "solar": {
    "currentW": 2500,
    "todayWh": 8500
  },
  "grid": {
    "powerW": -500,
    "importing": false
  }
}
```

---

#### GET /api/pvpc/today

Returns PVPC prices for today.

**Response:**
```json
{
  "date": "2024-02-15",
  "prices": [
    {
      "hour": 0,
      "price": 0.05123,
      "priceWithVAT": 0.06199,
      "isCheap": true,
      "isExpensive": false
    }
    // ... 24 hours
  ],
  "avgPrice": 0.11234,
  "minPrice": 0.04521,
  "maxPrice": 0.18923,
  "cheapHours": [0, 1, 2, 3, 4, 5],
  "expensiveHours": [18, 19, 20, 21]
}
```

---

#### GET /api/pvpc/tomorrow

Returns PVPC prices for tomorrow (available after 20:15).

**Response:** Same format as `/api/pvpc/today`

**Error Response (before 20:15):**
```json
{
  "error": "Tomorrow's prices not yet available",
  "availableAt": "20:15"
}
```

---

#### GET /api/solar/forecast

Returns solar production forecast.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `days` | number | Number of days (1-7), default: 1 |

**Response:**
```json
{
  "date": "2024-02-15",
  "forecast": [
    {
      "hour": 0,
      "watts": 0,
      "irradiance": 0
    },
    {
      "hour": 8,
      "watts": 500,
      "irradiance": 150
    }
    // ... 24 hours
  ],
  "totalWh": 18500,
  "peakWatts": 4200,
  "peakHour": 13,
  "sunriseHour": 7,
  "sunsetHour": 18
}
```

---

#### GET /api/plan/today

Returns the optimized charging plan for today.

**Response:**
```json
{
  "date": "2024-02-15",
  "hourlyPlan": [
    {
      "hour": 0,
      "price": 0.05,
      "solarWatts": 0,
      "decision": {
        "action": "charge_from_grid",
        "reason": "Cheap hour, low battery",
        "priority": "high"
      },
      "expectedSoC": 0.55
    }
    // ... 24 hours
  ],
  "gridChargeHours": [0, 1, 2, 3, 4],
  "gridChargeCost": 0.82,
  "solarChargeWh": 12500,
  "gridExportWh": 3200,
  "savings": 1.45,
  "recommendations": [
    "Consider running high-power appliances at 13:00-15:00 (peak solar)",
    "Avoid grid consumption 18:00-22:00 (expensive hours)"
  ]
}
```

---

#### POST /api/plan/generate

Force generation of a new charging plan.

**Request Body:**
```json
{
  "currentSoC": 0.45,
  "targetSoC": 0.9,
  "consumptionProfile": "default"
}
```

**Response:** Same as GET /api/plan/today

---

#### GET /api/savings

Returns savings analytics.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `period` | string | `daily`, `weekly`, `monthly`, `yearly` |
| `date` | string | Reference date (ISO format) |

**Response:**
```json
{
  "period": "monthly",
  "date": "2024-02",
  "withOptimization": 45.23,
  "withoutOptimization": 78.90,
  "savings": 33.67,
  "savingsPercent": 42.7,
  "co2Avoided": 15.3,
  "breakdown": {
    "solarSavings": 22.50,
    "peakShiftingSavings": 11.17
  }
}
```

---

#### GET /api/savings/projection

Returns projected savings and ROI analysis.

**Response:**
```json
{
  "daily": { /* ... */ },
  "weekly": { /* ... */ },
  "monthly": {
    "month": "February",
    "year": 2024,
    "totalSavings": 33.67,
    "projectedAnnualSavings": 404.04,
    "avgDailySavings": 1.12,
    "daysTracked": 15,
    "co2Avoided": 15.3
  },
  "yearly": { /* ... */ },
  "breakeven": {
    "batteryInvestment": 5000,
    "monthlySavings": 33.67,
    "monthsToBreakeven": 148,
    "breakevenDate": "2036-06-15",
    "roi5Year": 103.2,
    "roi10Year": 380.5
  }
}
```

---

#### POST /api/config

Update configuration.

**Request Body:**
```json
{
  "battery": {
    "capacity_wh": 15000
  },
  "pvpc": {
    "tariff": "3.0TD"
  }
}
```

**Response:**
```json
{
  "success": true,
  "config": { /* updated config */ }
}
```

---

### WebSocket Events

Connect to `/ws` for real-time updates.

#### Connection

```javascript
const ws = new WebSocket('ws://localhost:8099/ws');

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message.type, message.data);
};
```

#### Event Types

| Event | Description |
|-------|-------------|
| `status_update` | System status changed |
| `price_update` | New PVPC prices available |
| `plan_update` | Charging plan regenerated |
| `decision` | New charging decision made |
| `alert` | Important alert (low battery, etc.) |

#### Example Messages

```json
// Status update
{
  "type": "status_update",
  "timestamp": "2024-02-15T10:30:00Z",
  "data": {
    "batterySoC": 0.72,
    "solarPowerW": 3200,
    "gridPowerW": -800,
    "currentAction": "charge_from_solar"
  }
}

// Decision
{
  "type": "decision",
  "timestamp": "2024-02-15T10:30:00Z",
  "data": {
    "action": "discharge",
    "reason": "Expensive hour starting, discharging battery",
    "priority": "high"
  }
}

// Alert
{
  "type": "alert",
  "timestamp": "2024-02-15T10:30:00Z",
  "data": {
    "level": "warning",
    "message": "Battery SoC below 20%",
    "action": "Scheduling grid charge for next cheap hour"
  }
}
```

## Data Types

### BatteryConfig

```typescript
interface BatteryConfig {
  capacityWh: number;      // Total battery capacity in Wh
  maxChargeRateW: number;  // Maximum charge rate in W
  minSoC: number;          // Minimum state of charge (0-1)
  maxSoC: number;          // Maximum state of charge (0-1)
  currentSoC: number;      // Current state of charge (0-1)
}
```

### ChargingDecision

```typescript
interface ChargingDecision {
  action: 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle';
  reason: string;
  priority: 'high' | 'medium' | 'low';
}
```

### PVPCPrice

```typescript
interface PVPCPrice {
  hour: number;          // 0-23
  price: number;         // €/kWh without VAT
  priceWithVAT: number;  // €/kWh with VAT
  isCheap: boolean;      // Below average
  isExpensive: boolean;  // Above 150% of average
}
```

### SolarForecast

```typescript
interface SolarForecast {
  hour: number;      // 0-23
  watts: number;     // Expected production in W
  irradiance: number; // Solar irradiance W/m²
}
```

## Examples

### Python Example

```python
import requests

BASE_URL = "http://localhost:8099"

# Get today's plan
response = requests.get(f"{BASE_URL}/api/plan/today")
plan = response.json()

print(f"Grid charge hours: {plan['gridChargeHours']}")
print(f"Expected savings: €{plan['savings']:.2f}")

# Get current prices
response = requests.get(f"{BASE_URL}/api/pvpc/today")
pvpc = response.json()

current_hour = datetime.now().hour
current_price = pvpc['prices'][current_hour]['price']
print(f"Current price: €{current_price:.4f}/kWh")
```

### JavaScript Example

```javascript
// Fetch and display savings projection
async function showSavingsProjection() {
  const response = await fetch('/api/savings/projection');
  const data = await response.json();
  
  console.log(`Monthly savings: €${data.monthly.totalSavings.toFixed(2)}`);
  console.log(`CO2 avoided: ${data.monthly.co2Avoided.toFixed(1)} kg`);
  console.log(`Breakeven in: ${data.breakeven.monthsToBreakeven} months`);
}

// WebSocket for real-time updates
const ws = new WebSocket('ws://localhost:8099/ws');

ws.onmessage = (event) => {
  const { type, data } = JSON.parse(event.data);
  
  if (type === 'decision') {
    updateDashboard(data);
  }
};
```

### Home Assistant Automation Example

```yaml
automation:
  - alias: "VoltAssistant - Start Cheap Hour Charging"
    trigger:
      - platform: webhook
        webhook_id: voltassistant_charge_start
    action:
      - service: switch.turn_on
        target:
          entity_id: switch.battery_grid_charge

  - alias: "VoltAssistant - Stop Charging"
    trigger:
      - platform: webhook
        webhook_id: voltassistant_charge_stop
    action:
      - service: switch.turn_off
        target:
          entity_id: switch.battery_grid_charge
```

## Error Handling

All endpoints return errors in this format:

```json
{
  "error": "Error description",
  "code": "ERROR_CODE",
  "details": { /* optional additional info */ }
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `PVPC_UNAVAILABLE` | PVPC data not available |
| `SOLAR_FORECAST_ERROR` | Failed to get solar forecast |
| `HA_CONNECTION_ERROR` | Cannot connect to Home Assistant |
| `INVALID_CONFIG` | Configuration error |
| `RATE_LIMITED` | Too many requests |

## Rate Limits

- REST API: 60 requests per minute
- WebSocket: 10 messages per second

## Support

- GitHub Issues: https://github.com/voltassistant/addon/issues
- Documentation: https://voltassistant.github.io/docs

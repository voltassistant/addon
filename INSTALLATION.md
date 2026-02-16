# ⚡ VoltAssistant Addon Installation Guide

## Prerequisites
- Home Assistant with Supervisor (HAOS or supervised install)
- VoltAssistant Cloud running at `http://192.168.31.73:3000`
- Deye/Solarman inverter integrated via Home Assistant

## Step 1: Add Custom Repository

1. Open Home Assistant
2. Go to **Settings** → **Add-ons** → **Add-on Store**
3. Click the three dots (⋮) in the top right → **Repositories**
4. Add this URL:
   ```
   https://github.com/voltassistant/addon
   ```
5. Click **Add** → **Close**

## Step 2: Install the Add-on

1. Refresh the Add-on Store (pull down or click reload)
2. Find **VoltAssistant** in the list
3. Click → **Install**
4. Wait for installation to complete

## Step 3: Configure

1. Go to the **Configuration** tab of the add-on
2. Set the following options:

```yaml
cloud_api_key: "R_dpRGmBFS1k4nVIaYLV8fDSttFm5gAMNmossVxU2zE"
cloud_url: "http://192.168.31.73:3000"
ha_url: "http://supervisor/core"
scheduler_interval_minutes: 15
low_price_percentile: 20
high_price_percentile: 80
```

3. Click **Save**

## Step 4: Start

1. Go to the **Info** tab
2. Enable **Start on boot** and **Watchdog**
3. Click **Start**
4. Click **Open Web UI** to access the dashboard

## Step 5: Verify Connection

Check the VoltAssistant Cloud dashboard at http://192.168.31.73:3000 to see your installation appear online.

---

## Entity Configuration

The add-on expects these Home Assistant entities (configurable):

| Entity | Description |
|--------|-------------|
| `sensor.inverter_battery_soc` | Battery state of charge (%) |
| `sensor.inverter_pv_power` | Solar power (W) |
| `sensor.inverter_grid_power` | Grid power (W) |
| `number.inverter_program_1_soc` | Target SOC control |

If your entities have different names, edit the add-on's config file.

## Troubleshooting

### "Home Assistant not available"
- Check `ha_url` is correct
- Add-on runs inside Supervisor: use `http://supervisor/core`

### "Cloud connection failed"
- Verify cloud is running: `curl http://192.168.31.73:3000/health`
- Check API key is correct
- Ensure firewall allows connection from HA to 192.168.31.73

### "Entity not found"
- Verify entity names in Developer Tools → States
- Update config to match your actual entity IDs

---

## Cloud Dashboard Login

- URL: http://192.168.31.73:3000
- Email: arturo@voltassistant.io
- Password: (see .voltassistant-credentials file)

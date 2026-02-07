/**
 * Home Assistant Integration for VoltAssistant
 * 
 * Provides functions to interact with Home Assistant for:
 * - Reading current battery state
 * - Setting charge/discharge modes on the inverter
 * - Creating automations based on the optimal plan
 */

import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const HA_URL = process.env.HA_URL || process.env.HOME_ASSISTANT_URL || 'http://localhost:8123'
const HA_TOKEN = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN || ''

// Common Deye inverter entities (adjust to your setup)
const DEYE_ENTITIES = {
  // Sensors
  batterySOC: 'sensor.deye_battery_soc',
  batteryPower: 'sensor.deye_battery_power',
  solarPower: 'sensor.deye_pv_power',
  gridPower: 'sensor.deye_grid_power',
  loadPower: 'sensor.deye_load_power',
  
  // Controls (via Modbus/Solarman)
  workMode: 'select.deye_work_mode',
  gridCharge: 'switch.deye_grid_charge',
  batteryChargeLimit: 'number.deye_battery_charge_limit',
  batteryDischargeLimit: 'number.deye_battery_discharge_limit',
}

interface HAState {
  entity_id: string
  state: string
  attributes: Record<string, any>
  last_changed: string
  last_updated: string
}

interface BatteryStatus {
  soc: number // 0-100
  power: number // Watts (positive = charging, negative = discharging)
  solarPower: number
  gridPower: number
  loadPower: number
  isCharging: boolean
  isDischarging: boolean
}

// Get headers for HA API
function getHeaders() {
  return {
    'Authorization': `Bearer ${HA_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Get entity state from Home Assistant
 */
export async function getEntityState(entityId: string): Promise<HAState | null> {
  try {
    const response = await axios.get(`${HA_URL}/api/states/${entityId}`, {
      headers: getHeaders(),
    })
    return response.data
  } catch (error) {
    console.error(`Failed to get state for ${entityId}:`, (error as Error).message)
    return null
  }
}

/**
 * Set entity state in Home Assistant
 */
export async function setEntityState(entityId: string, state: string): Promise<boolean> {
  try {
    const domain = entityId.split('.')[0]
    let service = 'set_value'
    
    if (domain === 'switch') {
      service = state === 'on' ? 'turn_on' : 'turn_off'
    } else if (domain === 'select') {
      service = 'select_option'
    } else if (domain === 'number') {
      service = 'set_value'
    }
    
    const payload: Record<string, any> = { entity_id: entityId }
    if (domain === 'select') payload.option = state
    if (domain === 'number') payload.value = parseFloat(state)
    
    await axios.post(`${HA_URL}/api/services/${domain}/${service}`, payload, {
      headers: getHeaders(),
    })
    return true
  } catch (error) {
    console.error(`Failed to set state for ${entityId}:`, (error as Error).message)
    return false
  }
}

/**
 * Call Home Assistant service
 */
export async function callService(domain: string, service: string, data: Record<string, any>): Promise<boolean> {
  try {
    await axios.post(`${HA_URL}/api/services/${domain}/${service}`, data, {
      headers: getHeaders(),
    })
    return true
  } catch (error) {
    console.error(`Failed to call ${domain}.${service}:`, (error as Error).message)
    return false
  }
}

/**
 * Get current battery status
 */
export async function getBatteryStatus(): Promise<BatteryStatus | null> {
  try {
    const [soc, power, solar, grid, load] = await Promise.all([
      getEntityState(DEYE_ENTITIES.batterySOC),
      getEntityState(DEYE_ENTITIES.batteryPower),
      getEntityState(DEYE_ENTITIES.solarPower),
      getEntityState(DEYE_ENTITIES.gridPower),
      getEntityState(DEYE_ENTITIES.loadPower),
    ])
    
    const batteryPower = parseFloat(power?.state || '0')
    
    return {
      soc: parseFloat(soc?.state || '0'),
      power: batteryPower,
      solarPower: parseFloat(solar?.state || '0'),
      gridPower: parseFloat(grid?.state || '0'),
      loadPower: parseFloat(load?.state || '0'),
      isCharging: batteryPower > 50,
      isDischarging: batteryPower < -50,
    }
  } catch (error) {
    console.error('Failed to get battery status:', (error as Error).message)
    return null
  }
}

/**
 * Enable grid charging
 */
export async function enableGridCharge(): Promise<boolean> {
  console.log('🔌 Enabling grid charge...')
  return setEntityState(DEYE_ENTITIES.gridCharge, 'on')
}

/**
 * Disable grid charging
 */
export async function disableGridCharge(): Promise<boolean> {
  console.log('🔌 Disabling grid charge...')
  return setEntityState(DEYE_ENTITIES.gridCharge, 'off')
}

/**
 * Set battery charge limit
 */
export async function setBatteryChargeLimit(limitPercent: number): Promise<boolean> {
  console.log(`🔋 Setting charge limit to ${limitPercent}%...`)
  return setEntityState(DEYE_ENTITIES.batteryChargeLimit, limitPercent.toString())
}

/**
 * Set work mode
 */
export async function setWorkMode(mode: 'selling_first' | 'zero_export' | 'self_use'): Promise<boolean> {
  console.log(`⚙️ Setting work mode to ${mode}...`)
  return setEntityState(DEYE_ENTITIES.workMode, mode)
}

/**
 * Send notification via Home Assistant
 */
export async function sendNotification(title: string, message: string, target: string = 'mobile_app'): Promise<boolean> {
  return callService('notify', target, { title, message })
}

/**
 * Fire an event in Home Assistant (for automations)
 */
export async function fireEvent(eventType: string, eventData: Record<string, any>): Promise<boolean> {
  try {
    await axios.post(`${HA_URL}/api/events/${eventType}`, eventData, {
      headers: getHeaders(),
    })
    return true
  } catch (error) {
    console.error(`Failed to fire event ${eventType}:`, (error as Error).message)
    return false
  }
}

/**
 * Apply charging action based on plan
 */
export async function applyChargingAction(action: 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle'): Promise<boolean> {
  switch (action) {
    case 'charge_from_grid':
      await enableGridCharge()
      await setWorkMode('self_use')
      return true
      
    case 'charge_from_solar':
      await disableGridCharge()
      await setWorkMode('self_use')
      return true
      
    case 'discharge':
      await disableGridCharge()
      await setWorkMode('selling_first')
      return true
      
    case 'idle':
    default:
      await disableGridCharge()
      await setWorkMode('self_use')
      return true
  }
}

/**
 * Check if Home Assistant is reachable
 */
export async function checkConnection(): Promise<boolean> {
  if (!HA_TOKEN) {
    console.error('❌ HA_TOKEN not configured')
    return false
  }
  
  try {
    const response = await axios.get(`${HA_URL}/api/`, {
      headers: getHeaders(),
      timeout: 5000,
    })
    console.log(`✅ Connected to Home Assistant: ${response.data.message}`)
    return true
  } catch (error) {
    console.error('❌ Cannot connect to Home Assistant:', (error as Error).message)
    return false
  }
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2)
  const command = args[0]
  
  async function main() {
    if (!await checkConnection()) {
      process.exit(1)
    }
    
    switch (command) {
      case 'status':
        const status = await getBatteryStatus()
        console.log('\n🔋 Battery Status:')
        console.log(JSON.stringify(status, null, 2))
        break
        
      case 'charge':
        await applyChargingAction('charge_from_grid')
        console.log('✅ Grid charging enabled')
        break
        
      case 'discharge':
        await applyChargingAction('discharge')
        console.log('✅ Discharge mode enabled')
        break
        
      case 'auto':
        await applyChargingAction('idle')
        console.log('✅ Auto mode enabled')
        break
        
      default:
        console.log(`
Usage: npx ts-node src/ha-integration.ts <command>

Commands:
  status    - Get current battery status
  charge    - Enable grid charging
  discharge - Enable discharge/selling mode
  auto      - Set to automatic/self-use mode

Environment:
  HA_URL    - Home Assistant URL (default: http://localhost:8123)
  HA_TOKEN  - Long-lived access token
`)
    }
  }
  
  main().catch(console.error)
}

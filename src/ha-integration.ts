/**
 * Home Assistant Integration for VoltAssistant
 * 
 * Provides functions to interact with Home Assistant for:
 * - Reading current battery state
 * - Setting charge/discharge modes on the inverter
 * - Simplified control using Program 1 (00:00-23:59)
 * 
 * Control Strategy:
 * - program_1_charging: "Grid" (charge from grid) or "Disabled" (solar only)
 * - program_1_soc: Target SOC (15-95%)
 */

import axios from 'axios'
import dotenv from 'dotenv'
import { loadConfig, getHAEntities, HAEntitiesConfig } from './config'

dotenv.config()

const HA_URL = process.env.HA_URL || process.env.HOME_ASSISTANT_URL || 'http://localhost:8123'
const HA_TOKEN = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN || ''

// Get the SOC control entity from config
function getSOCEntity(): string {
  try {
    const config = loadConfig()
    return config.home_assistant.entities.controls.program_1_soc || 'number.inverter_program_1_soc'
  } catch {
    return 'number.inverter_program_1_soc'
  }
}

// Get entities from config (with fallback to defaults)
function getEntities(): HAEntitiesConfig {
  try {
    return getHAEntities()
  } catch {
    // Fallback if config not available
    return {
      sensors: {
        battery_soc: 'sensor.inverter_battery_soc',
        battery_power: 'sensor.inverter_battery_power',
        solar_power: 'sensor.inverter_pv_power',
        grid_power: 'sensor.inverter_grid_power',
        load_power: 'sensor.inverter_load_l1_power',
        inverter_temp: 'sensor.inverter_temperature',
      },
      controls: {
        work_mode: 'select.inverter_work_mode',
        program_1_soc: 'number.inverter_program_1_soc',
        program_1_charging: 'select.inverter_program_1_charging',
      },
    }
  }
}

function getWorkModes(): { export_first?: string; zero_export_load?: string; zero_export_ct?: string; self_use?: string; selling_first?: string; zero_export?: string } {
  try {
    const config = loadConfig()
    return config.home_assistant.work_modes || {}
  } catch {
    return {}
  }
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
      timeout: 10000,
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
      timeout: 10000,
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
      timeout: 10000,
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
    const entities = getEntities()
    
    const [soc, power, solar, grid, load] = await Promise.all([
      getEntityState(entities.sensors.battery_soc),
      getEntityState(entities.sensors.battery_power),
      getEntityState(entities.sensors.solar_power),
      getEntityState(entities.sensors.grid_power),
      getEntityState(entities.sensors.load_power),
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
 * Set target SOC for Program 1
 * This is the ONLY control needed:
 * - 0% = no grid charging (equivalent to disabled)
 * - 30%, 80%, 95% = charge from grid up to that SOC
 * 
 * @param soc - Target SOC percentage (0-95)
 */
export async function setTargetSOC(soc: number): Promise<boolean> {
  const entity = getSOCEntity()
  const clampedSoc = Math.max(0, Math.min(95, soc))
  
  console.log(`🎯 Setting target SOC: ${clampedSoc}%${clampedSoc === 0 ? ' (grid charging disabled)' : ''}`)
  console.log(`   Entity: ${entity} → ${clampedSoc}`)
  
  const success = await setEntityState(entity, clampedSoc.toString())
  if (!success) {
    console.error(`❌ Failed to set ${entity}`)
  }
  return success
}

/**
 * Get current target SOC from HA
 */
export async function getCurrentTargetSOC(): Promise<number | null> {
  const entity = getSOCEntity()
  const state = await getEntityState(entity)
  
  if (!state) {
    return null
  }
  
  return parseFloat(state.state) || 0
}

/**
 * Get current settings from HA (for comparison)
 */
export async function getCurrentSettings(): Promise<{ targetSoc: number } | null> {
  const targetSoc = await getCurrentTargetSOC()
  if (targetSoc === null) {
    return null
  }
  return { targetSoc }
}

// Legacy functions for backwards compatibility
export async function enableGridCharge(): Promise<boolean> {
  return setTargetSOC(80)
}

export async function disableGridCharge(): Promise<boolean> {
  return setTargetSOC(0)
}

export async function setBatteryChargeLimit(limitPercent: number): Promise<boolean> {
  return setTargetSOC(limitPercent)
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
      timeout: 10000,
    })
    return true
  } catch (error) {
    console.error(`Failed to fire event ${eventType}:`, (error as Error).message)
    return false
  }
}

/**
/**
 * Simplified control decision
 * Uses ONLY program_1_soc to control everything:
 * - 0% = no grid charging (equivalent to "Disabled")
 * - 30%, 80%, 95% = charge from grid up to that SOC
 */
export interface ControlDecision {
  targetSoc: number  // 0 = no grid charge, 30/80/95 = charge to that level
  reason: string
}

export async function applyControlDecision(decision: ControlDecision): Promise<boolean> {
  console.log(`\n🎯 Applying control decision:`)
  console.log(`   Target SOC: ${decision.targetSoc}% ${decision.targetSoc === 0 ? '(grid charge disabled)' : '(grid charge enabled)'}`)
  console.log(`   Reason: ${decision.reason}`)
  
  try {
    const ok = await setTargetSOC(decision.targetSoc)
    
    if (ok) {
      console.log(`✅ Control decision applied successfully`)
      return true
    } else {
      console.error(`⚠️ Failed to set target SOC`)
      return false
    }
  } catch (error) {
    console.error(`❌ Failed to apply control decision:`, (error as Error).message)
    return false
  }
}

/**
 * Apply charging action based on plan (legacy interface)
 * Maps old actions to new simplified control
 */
export async function applyChargingAction(action: 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle'): Promise<boolean> {
  try {
    switch (action) {
      case 'charge_from_grid':
        // Grid charging enabled, target 80%
        return applyControlDecision({
          targetSoc: 80,
          reason: 'Grid charging requested',
        })
        
      case 'charge_from_solar':
        // No grid charging (SOC=0), let solar do its thing
        return applyControlDecision({
          targetSoc: 0,
          reason: 'Solar charging mode (grid disabled)',
        })
        
      case 'discharge':
        // No grid charging, allow discharge
        return applyControlDecision({
          targetSoc: 0,
          reason: 'Discharge/selling mode (grid disabled)',
        })
        
      case 'idle':
      default:
        // No grid charging in idle
        return applyControlDecision({
          targetSoc: 0,
          reason: 'Idle/standby mode (grid disabled)',
        })
    }
  } catch (error) {
    console.error(`Failed to apply action ${action}:`, (error as Error).message)
    return false
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

/**
 * Test connection and verify all configured entities exist
 */
export async function testConnection(): Promise<boolean> {
  if (!HA_TOKEN) {
    console.error('❌ HA_TOKEN not configured')
    return false
  }
  
  try {
    // First check basic connection
    const response = await axios.get(`${HA_URL}/api/`, {
      headers: getHeaders(),
      timeout: 5000,
    })
    
    return true
  } catch (error) {
    console.error('❌ Cannot connect to Home Assistant:', (error as Error).message)
    return false
  }
}

/**
 * Verify all configured entities exist in HA
 */
export async function verifyEntities(): Promise<{
  valid: boolean
  missing: string[]
  found: string[]
}> {
  const entities = getEntities()
  const allEntities = [
    ...Object.values(entities.sensors),
    ...Object.values(entities.controls),
  ].filter(Boolean) as string[]
  
  const missing: string[] = []
  const found: string[] = []
  
  for (const entityId of allEntities) {
    const state = await getEntityState(entityId)
    if (state) {
      found.push(entityId)
    } else {
      missing.push(entityId)
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
    found,
  }
}

/**
 * Get full system status including all entities
 */
export async function getFullStatus(): Promise<{
  connected: boolean
  battery: BatteryStatus | null
  entities: Record<string, { state: string; available: boolean }>
}> {
  const connected = await checkConnection()
  if (!connected) {
    return { connected: false, battery: null, entities: {} }
  }
  
  const battery = await getBatteryStatus()
  const entitiesConfig = getEntities()
  const allEntities = {
    ...entitiesConfig.sensors,
    ...entitiesConfig.controls,
  }
  
  const entityStates: Record<string, { state: string; available: boolean }> = {}
  
  for (const [name, entityId] of Object.entries(allEntities)) {
    if (!entityId) continue
    const state = await getEntityState(entityId)
    entityStates[name] = {
      state: state?.state || 'unavailable',
      available: state !== null && state.state !== 'unavailable',
    }
  }
  
  return { connected, battery, entities: entityStates }
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
        
      case 'verify':
        console.log('\n🔍 Verificando entidades...')
        const result = await verifyEntities()
        console.log(`\n✅ Encontradas: ${result.found.length}`)
        result.found.forEach(e => console.log(`   - ${e}`))
        if (result.missing.length > 0) {
          console.log(`\n❌ No encontradas: ${result.missing.length}`)
          result.missing.forEach(e => console.log(`   - ${e}`))
        }
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
  verify    - Verify all configured entities exist
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

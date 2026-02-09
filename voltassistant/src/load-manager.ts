/**
 * Load Manager for VoltAssistant
 * Smart load shedding based on priorities, SOC, prices, and solar production.
 * Integrates with the autonomous scheduler for automatic load management.
 * 
 * Priorities:
 *   critical (nunca apagar) > comfort (reducir si hace falta) > accessory (primero en apagar)
 */

import { getEntityState, callService } from './ha-integration'
import { getLoadsConfig, updateLoadsConfig, LoadDevice, LoadPriority, LoadsConfig } from './config'
import {
  saveLoadAction,
  getLoadState,
  getAllLoadStates,
  markLoadShed,
  markLoadRestored,
  getShedLoads,
  getLoadShedDuration,
  getLoadActionHistory,
  LoadAction,
  LoadState,
} from './storage'

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface LoadStatus extends LoadDevice {
  is_on: boolean
  is_shed: boolean
  shed_since: string | null
  shed_reason: string | null
  shed_duration_minutes: number | null
  entity_available: boolean
}

export interface LoadEvaluationContext {
  soc: number           // Battery SOC 0-100
  price: number         // Current price €/kWh
  pricePercentile: number // Price percentile 0-100
  solarPower: number    // Current solar production W
  loadPower: number     // Current total consumption W
}

export interface LoadEvaluationResult {
  action: 'shed' | 'restore' | 'none'
  devices: string[]     // Device IDs to act on
  reason: string
}

export interface LoadManagerState {
  enabled: boolean
  totalConfiguredLoads: number
  shedLoads: LoadStatus[]
  activeLoads: LoadStatus[]
  allLoads: LoadStatus[]
  maxInverterPower: number
  safetyMarginPercent: number
  lastEvaluation: string | null
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if entity exists and is available in HA
 */
async function isEntityAvailable(entityId: string): Promise<boolean> {
  try {
    const entity = await getEntityState(entityId)
    if (!entity) return false
    return entity.state !== 'unavailable' && entity.state !== 'unknown'
  } catch {
    return false
  }
}

/**
 * Check if entity is on
 */
async function isEntityOn(entityId: string): Promise<boolean> {
  try {
    const entity = await getEntityState(entityId)
    if (!entity) return false
    return entity.state === 'on'
  } catch {
    return false
  }
}

/**
 * Turn off a switch entity
 */
async function turnOff(entityId: string): Promise<boolean> {
  try {
    const domain = entityId.split('.')[0]
    return await callService(domain, 'turn_off', { entity_id: entityId })
  } catch (error) {
    console.error(`❌ Error turning off ${entityId}:`, error)
    return false
  }
}

/**
 * Turn on a switch entity
 */
async function turnOn(entityId: string): Promise<boolean> {
  try {
    const domain = entityId.split('.')[0]
    return await callService(domain, 'turn_on', { entity_id: entityId })
  } catch (error) {
    console.error(`❌ Error turning on ${entityId}:`, error)
    return false
  }
}

/**
 * Get priority order for shedding (accessory first, then comfort)
 */
function getShedOrder(): LoadPriority[] {
  return ['accessory', 'comfort']
}

/**
 * Get priority order for restoring (comfort first, then accessory)
 */
function getRestoreOrder(): LoadPriority[] {
  return ['comfort', 'accessory']
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the full status of a load device
 */
export async function getLoadStatus(device: LoadDevice): Promise<LoadStatus> {
  const state = getLoadState(device.id)
  const entityAvailable = await isEntityAvailable(device.entity_id)
  const isOn = entityAvailable ? await isEntityOn(device.entity_id) : false
  const shedDuration = getLoadShedDuration(device.id)

  return {
    ...device,
    is_on: isOn,
    is_shed: state?.is_shed || false,
    shed_since: state?.shed_since || null,
    shed_reason: state?.shed_reason || null,
    shed_duration_minutes: shedDuration,
    entity_available: entityAvailable,
  }
}

/**
 * Get status of all configured loads
 */
export async function getAllLoadStatuses(): Promise<LoadStatus[]> {
  const config = getLoadsConfig()
  const statuses: LoadStatus[] = []

  for (const device of config.devices) {
    statuses.push(await getLoadStatus(device))
  }

  return statuses
}

/**
 * Get current load manager state
 */
export async function getLoadManagerState(): Promise<LoadManagerState> {
  const config = getLoadsConfig()
  const allLoads = await getAllLoadStatuses()

  return {
    enabled: config.enabled,
    totalConfiguredLoads: config.devices.length,
    shedLoads: allLoads.filter(l => l.is_shed),
    activeLoads: allLoads.filter(l => l.is_on && !l.is_shed),
    allLoads,
    maxInverterPower: config.max_inverter_power,
    safetyMarginPercent: config.safety_margin_percent,
    lastEvaluation: new Date().toISOString(),
  }
}

/**
 * Check if a load can be restored (respects min_off_minutes)
 */
export function canRestoreLoad(deviceId: string, minOffMinutes: number): boolean {
  const shedDuration = getLoadShedDuration(deviceId)
  if (shedDuration === null) return true // Not shed
  return shedDuration >= minOffMinutes
}

/**
 * Shed a specific load
 */
export async function shedLoad(
  deviceId: string,
  reason: string,
  context: { soc: number; price: number; solarWatts?: number; loadWatts?: number }
): Promise<boolean> {
  const config = getLoadsConfig()
  const device = config.devices.find(d => d.id === deviceId)

  if (!device) {
    console.warn(`⚠️ Load device not found: ${deviceId}`)
    return false
  }

  if (device.priority === 'critical') {
    console.warn(`⚠️ Cannot shed critical load: ${device.name}`)
    return false
  }

  if (!device.can_shed) {
    console.warn(`⚠️ Load cannot be shed: ${device.name}`)
    return false
  }

  // Check if entity is available
  const available = await isEntityAvailable(device.entity_id)
  if (!available) {
    console.warn(`⚠️ Entity not available in HA: ${device.entity_id}`)
    return false
  }

  // Turn off the load
  console.log(`⚡ Shedding load: ${device.name} (${device.power_watts}W) - ${reason}`)
  const success = await turnOff(device.entity_id)

  if (success) {
    // Update state in SQLite
    markLoadShed(deviceId, reason)

    // Log action
    saveLoadAction({
      timestamp: new Date().toISOString(),
      device_id: deviceId,
      device_name: device.name,
      action: 'shed',
      reason,
      soc: context.soc,
      price: context.price,
      solar_watts: context.solarWatts,
      load_watts: context.loadWatts,
    })

    console.log(`✅ Load shed successfully: ${device.name}`)
  } else {
    console.error(`❌ Failed to shed load: ${device.name}`)
  }

  return success
}

/**
 * Restore a specific load
 */
export async function restoreLoad(
  deviceId: string,
  reason: string,
  context: { soc: number; price: number; solarWatts?: number; loadWatts?: number }
): Promise<boolean> {
  const config = getLoadsConfig()
  const device = config.devices.find(d => d.id === deviceId)

  if (!device) {
    console.warn(`⚠️ Load device not found: ${deviceId}`)
    return false
  }

  // Check min_off_minutes
  if (!canRestoreLoad(deviceId, device.min_off_minutes)) {
    const duration = getLoadShedDuration(deviceId)
    console.log(`⏳ Cannot restore ${device.name} yet - only off for ${duration} min (min: ${device.min_off_minutes} min)`)
    return false
  }

  // Check if entity is available
  const available = await isEntityAvailable(device.entity_id)
  if (!available) {
    console.warn(`⚠️ Entity not available in HA: ${device.entity_id}`)
    return false
  }

  // Turn on the load
  console.log(`⚡ Restoring load: ${device.name} - ${reason}`)
  const success = await turnOn(device.entity_id)

  if (success) {
    // Update state in SQLite
    markLoadRestored(deviceId)

    // Log action
    saveLoadAction({
      timestamp: new Date().toISOString(),
      device_id: deviceId,
      device_name: device.name,
      action: 'restore',
      reason,
      soc: context.soc,
      price: context.price,
      solar_watts: context.solarWatts,
      load_watts: context.loadWatts,
    })

    console.log(`✅ Load restored successfully: ${device.name}`)
  } else {
    console.error(`❌ Failed to restore load: ${device.name}`)
  }

  return success
}

/**
 * Evaluate loads and decide what actions to take
 * This is the main decision function called by the scheduler
 */
export async function evaluateLoads(context: LoadEvaluationContext): Promise<LoadEvaluationResult[]> {
  const config = getLoadsConfig()
  
  if (!config.enabled || config.devices.length === 0) {
    return []
  }

  const results: LoadEvaluationResult[] = []
  const allLoads = await getAllLoadStatuses()
  const maxPower = config.max_inverter_power * (1 - config.safety_margin_percent / 100)

  // Get loads that can be shed (not critical, can_shed=true, currently on)
  const sheddableLoads = allLoads
    .filter(l => l.priority !== 'critical' && l.can_shed && l.is_on && !l.is_shed && l.entity_available)
    .sort((a, b) => {
      // Sort by priority (accessory first), then by power (highest first)
      const priorityOrder: Record<LoadPriority, number> = { critical: 0, comfort: 1, accessory: 2 }
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority]
      if (priorityDiff !== 0) return priorityDiff
      return b.power_watts - a.power_watts
    })

  // Get loads that are currently shed and can be restored
  const restorableLoads = allLoads
    .filter(l => l.is_shed && l.entity_available)
    .filter(l => canRestoreLoad(l.id, l.min_off_minutes))
    .sort((a, b) => {
      // Sort by priority (comfort first), then by power (lowest first)
      const priorityOrder: Record<LoadPriority, number> = { critical: 0, comfort: 1, accessory: 2 }
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
      if (priorityDiff !== 0) return priorityDiff
      return a.power_watts - b.power_watts
    })

  const { soc, price, pricePercentile, solarPower, loadPower } = context

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEDDING RULES
  // ═══════════════════════════════════════════════════════════════════════════

  // Rule 1: Overload protection - shed by priority until safe
  if (loadPower > maxPower) {
    const excessPower = loadPower - maxPower
    let powerToShed = 0
    const devicesToShed: string[] = []

    for (const load of sheddableLoads) {
      if (powerToShed >= excessPower) break
      devicesToShed.push(load.id)
      powerToShed += load.power_watts
    }

    if (devicesToShed.length > 0) {
      results.push({
        action: 'shed',
        devices: devicesToShed,
        reason: `⚠️ Sobrecarga: ${loadPower}W > ${maxPower}W (máx seguro)`,
      })
    }
  }

  // Rule 2: Low SOC + expensive price - shed accessory loads
  if (soc < 20 && pricePercentile > 50) {
    const accessoryLoads = sheddableLoads.filter(l => l.priority === 'accessory')
    if (accessoryLoads.length > 0) {
      results.push({
        action: 'shed',
        devices: accessoryLoads.map(l => l.id),
        reason: `🔋 SOC bajo (${soc}%) + precio medio-alto (P${pricePercentile}) - desconectando cargas accessory`,
      })
    }
  }

  // Rule 3: Very low SOC - shed comfort loads too
  if (soc < 15) {
    const comfortLoads = sheddableLoads.filter(l => l.priority === 'comfort')
    if (comfortLoads.length > 0) {
      results.push({
        action: 'shed',
        devices: comfortLoads.map(l => l.id),
        reason: `⚠️ SOC crítico (${soc}%) - desconectando cargas comfort`,
      })
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESTORATION RULES
  // ═══════════════════════════════════════════════════════════════════════════

  // Rule 4: Good SOC + cheap price - restore all loads
  if (soc > 50 && pricePercentile < 30 && restorableLoads.length > 0) {
    results.push({
      action: 'restore',
      devices: restorableLoads.map(l => l.id),
      reason: `✅ SOC bueno (${soc}%) + precio bajo (P${pricePercentile}) - restaurando todas las cargas`,
    })
  }

  // Rule 5: Excess solar - restore loads to consume it
  const excessSolar = solarPower - loadPower
  if (excessSolar > 1000 && restorableLoads.length > 0) {
    // Only restore loads that fit in the excess
    const loadsToRestore: string[] = []
    let powerToAdd = 0

    for (const load of restorableLoads) {
      if (powerToAdd + load.power_watts <= excessSolar * 0.8) { // 80% safety
        loadsToRestore.push(load.id)
        powerToAdd += load.power_watts
      }
    }

    if (loadsToRestore.length > 0) {
      results.push({
        action: 'restore',
        devices: loadsToRestore,
        reason: `☀️ Exceso solar (${excessSolar}W) - restaurando cargas para aprovecharlo`,
      })
    }
  }

  // Rule 6: SOC recovered above safe threshold - gradually restore
  if (soc > 40 && pricePercentile < 50 && restorableLoads.length > 0) {
    // Restore one load at a time to be conservative
    const firstRestorable = restorableLoads[0]
    if (firstRestorable) {
      // Check we have headroom
      const headroom = maxPower - loadPower
      if (firstRestorable.power_watts <= headroom * 0.8) {
        results.push({
          action: 'restore',
          devices: [firstRestorable.id],
          reason: `🔋 SOC recuperado (${soc}%) + precio OK (P${pricePercentile}) - restaurando ${firstRestorable.name}`,
        })
      }
    }
  }

  return results
}

/**
 * Execute load management actions based on evaluation results
 */
export async function executeLoadActions(
  results: LoadEvaluationResult[],
  context: { soc: number; price: number; solarWatts?: number; loadWatts?: number }
): Promise<{ executed: string[]; failed: string[] }> {
  const executed: string[] = []
  const failed: string[] = []

  // Deduplicate - if same device appears in multiple results, last one wins
  // Filter out 'none' actions
  const actionByDevice = new Map<string, { action: 'shed' | 'restore'; reason: string }>()
  
  for (const result of results) {
    if (result.action === 'none') continue // Skip no-op actions
    for (const deviceId of result.devices) {
      actionByDevice.set(deviceId, { action: result.action, reason: result.reason })
    }
  }

  // Execute actions
  for (const [deviceId, { action, reason }] of actionByDevice) {
    let success: boolean

    if (action === 'shed') {
      success = await shedLoad(deviceId, reason, context)
    } else {
      success = await restoreLoad(deviceId, reason, context)
    }

    if (success) {
      executed.push(`${action}:${deviceId}`)
    } else {
      failed.push(`${action}:${deviceId}`)
    }
  }

  return { executed, failed }
}

/**
 * Force restore all shed loads (manual override)
 */
export async function forceRestoreAll(context?: { soc: number; price: number }): Promise<string[]> {
  const shedLoads = getShedLoads()
  const restored: string[] = []
  const ctx = context || { soc: 50, price: 0.1 }

  for (const state of shedLoads) {
    const success = await restoreLoad(
      state.device_id,
      'Restauración manual forzada',
      { soc: ctx.soc, price: ctx.price }
    )
    if (success) {
      restored.push(state.device_id)
    }
  }

  return restored
}

/**
 * Enable or disable load management
 */
export function setLoadManagerEnabled(enabled: boolean): void {
  updateLoadsConfig({ enabled })
  console.log(`🔌 Load manager ${enabled ? 'habilitado' : 'deshabilitado'}`)
}

/**
 * Get load action history
 */
export function getLoadHistory(limit: number = 100): LoadAction[] {
  return getLoadActionHistory(limit)
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY COMPATIBILITY (for existing API endpoints)
// ═══════════════════════════════════════════════════════════════════════════

export function getLoadManagerConfig(): LoadsConfig {
  return getLoadsConfig()
}

export function setLoadManagerConfig(updates: Partial<LoadsConfig>): LoadsConfig {
  return updateLoadsConfig(updates)
}

export async function updateState(): Promise<LoadManagerState> {
  return getLoadManagerState()
}

export async function balanceLoads(): Promise<{ actions: string[]; loadsAffected: string[] }> {
  // Legacy function - now just returns current state
  // Real balancing happens through evaluateLoads + executeLoadActions
  const state = await getLoadManagerState()
  return {
    actions: [],
    loadsAffected: state.shedLoads.map(l => l.id),
  }
}

export function addLoad(load: Omit<LoadDevice, 'priority'> & { priority: string }): LoadDevice {
  const config = getLoadsConfig()
  const newLoad: LoadDevice = {
    ...load,
    priority: load.priority as LoadPriority,
  }
  config.devices.push(newLoad)
  updateLoadsConfig({ devices: config.devices })
  return newLoad
}

export function removeLoad(loadId: string): boolean {
  const config = getLoadsConfig()
  const idx = config.devices.findIndex(d => d.id === loadId)
  if (idx >= 0) {
    config.devices.splice(idx, 1)
    updateLoadsConfig({ devices: config.devices })
    return true
  }
  return false
}

export function updateLoad(loadId: string, updates: Partial<LoadDevice>): LoadDevice | null {
  const config = getLoadsConfig()
  const device = config.devices.find(d => d.id === loadId)
  if (device) {
    Object.assign(device, updates)
    updateLoadsConfig({ devices: config.devices })
    return device
  }
  return null
}

export function setEnabled(enabled: boolean): void {
  setLoadManagerEnabled(enabled)
}

/**
 * Load Manager for VoltAssistant
 * Smart load shedding based on priorities:
 *   Essential (nunca apagar) > Comfort (reducir si hace falta) > Accessory (primero en apagar)
 */

import { getEntityState, setEntityState, callService } from './ha-integration'
import fs from 'fs'
import path from 'path'

// Types
export type LoadPriority = 'essential' | 'comfort' | 'accessory'

export interface Load {
  id: string
  name: string
  entity_id: string         // Main entity (power sensor or switch)
  priority: LoadPriority
  power_sensor?: string     // Sensor for current power consumption
  switch_entity?: string    // Switch to control on/off
  max_power: number         // Max expected power (W)
  current_power: number     // Current measured power (W)
  is_on: boolean
  can_control: boolean      // Has switch_entity
}

export interface LoadManagerConfig {
  enabled: boolean
  max_inverter_power: number   // Inverter max output (W)
  safety_margin: number        // % margin before shedding (e.g., 10 = shed at 90%)
  check_interval_seconds: number
  loads: Load[]
}

export interface LoadManagerState {
  totalPower: number
  maxAvailable: number
  usagePercent: number
  isOverloaded: boolean
  loads: Load[]
  shedLoads: string[]       // IDs of currently shed loads
  lastAction: {
    timestamp: string
    action: 'shed' | 'restore'
    loads: string[]
    reason: string
  } | null
  lastCheck: string | null
}

// Default config
const DEFAULT_CONFIG: LoadManagerConfig = {
  enabled: false,
  max_inverter_power: 6000,  // Deye SUN-6K-EU
  safety_margin: 10,
  check_interval_seconds: 30,
  loads: [],
}

// Config file path
const CONFIG_PATH = path.join(process.cwd(), 'data', 'load-manager-config.json')

// In-memory state
let config: LoadManagerConfig = { ...DEFAULT_CONFIG }
let state: LoadManagerState = {
  totalPower: 0,
  maxAvailable: 0,
  usagePercent: 0,
  isOverloaded: false,
  loads: [],
  shedLoads: [],
  lastAction: null,
  lastCheck: null,
}

/**
 * Load config from disk
 */
export function loadConfig(): LoadManagerConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf8')
      config = { ...DEFAULT_CONFIG, ...JSON.parse(data) }
    }
  } catch (err) {
    console.error('Error loading load manager config:', err)
  }
  return config
}

/**
 * Save config to disk
 */
export function saveConfig(): void {
  try {
    const dir = path.dirname(CONFIG_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  } catch (err) {
    console.error('Error saving load manager config:', err)
  }
}

/**
 * Get current config
 */
export function getLoadManagerConfig(): LoadManagerConfig {
  return config
}

/**
 * Update config
 */
export function setLoadManagerConfig(newConfig: Partial<LoadManagerConfig>): LoadManagerConfig {
  config = { ...config, ...newConfig }
  state.maxAvailable = config.max_inverter_power * (1 - config.safety_margin / 100)
  saveConfig()
  return config
}

/**
 * Add a load to manage
 */
export function addLoad(load: Omit<Load, 'current_power' | 'is_on' | 'can_control'>): Load {
  const newLoad: Load = {
    ...load,
    current_power: 0,
    is_on: true,
    can_control: !!load.switch_entity,
  }
  config.loads.push(newLoad)
  saveConfig()
  return newLoad
}

/**
 * Remove a load
 */
export function removeLoad(loadId: string): boolean {
  const idx = config.loads.findIndex(l => l.id === loadId)
  if (idx >= 0) {
    config.loads.splice(idx, 1)
    state.shedLoads = state.shedLoads.filter(id => id !== loadId)
    saveConfig()
    return true
  }
  return false
}

/**
 * Update a load
 */
export function updateLoad(loadId: string, updates: Partial<Load>): Load | null {
  const load = config.loads.find(l => l.id === loadId)
  if (load) {
    Object.assign(load, updates)
    load.can_control = !!load.switch_entity
    saveConfig()
    return load
  }
  return null
}

/**
 * Get numeric state from HA entity
 */
async function getNumericState(entityId: string): Promise<number> {
  const entity = await getEntityState(entityId)
  if (!entity || entity.state === 'unavailable' || entity.state === 'unknown') {
    return 0
  }
  return parseFloat(entity.state) || 0
}

/**
 * Check if entity is on
 */
async function isEntityOn(entityId: string): Promise<boolean> {
  const entity = await getEntityState(entityId)
  if (!entity) return false
  return entity.state === 'on'
}

/**
 * Turn off a switch
 */
async function turnOff(entityId: string): Promise<boolean> {
  const domain = entityId.split('.')[0]
  return callService(domain, 'turn_off', { entity_id: entityId })
}

/**
 * Turn on a switch
 */
async function turnOn(entityId: string): Promise<boolean> {
  const domain = entityId.split('.')[0]
  return callService(domain, 'turn_on', { entity_id: entityId })
}

/**
 * Update state by reading all load sensors
 */
export async function updateState(): Promise<LoadManagerState> {
  state.maxAvailable = config.max_inverter_power * (1 - config.safety_margin / 100)
  
  // Update all loads
  for (const load of config.loads) {
    // Read power
    const sensorId = load.power_sensor || load.entity_id
    if (sensorId) {
      load.current_power = await getNumericState(sensorId)
    }
    
    // Read on/off state
    if (load.switch_entity) {
      load.is_on = await isEntityOn(load.switch_entity)
    }
  }
  
  // Calculate totals
  state.loads = config.loads
  state.totalPower = config.loads.reduce((sum, l) => sum + (l.is_on ? l.current_power : 0), 0)
  state.usagePercent = (state.totalPower / config.max_inverter_power) * 100
  state.isOverloaded = state.totalPower > state.maxAvailable
  state.lastCheck = new Date().toISOString()
  
  return state
}

/**
 * Balance loads - shed or restore as needed
 */
export async function balanceLoads(): Promise<{
  actions: string[]
  loadsAffected: string[]
}> {
  if (!config.enabled) {
    return { actions: ['Load manager disabled'], loadsAffected: [] }
  }
  
  await updateState()
  
  const actions: string[] = []
  const loadsAffected: string[] = []
  
  if (state.isOverloaded) {
    const excessPower = state.totalPower - state.maxAvailable
    let powerSaved = 0
    
    // Priority order for shedding: accessory first, then comfort
    const shedOrder: LoadPriority[] = ['accessory', 'comfort']
    
    for (const priority of shedOrder) {
      if (powerSaved >= excessPower) break
      
      const loadsToShed = config.loads
        .filter(l => 
          l.priority === priority && 
          l.can_control && 
          l.is_on && 
          !state.shedLoads.includes(l.id)
        )
        .sort((a, b) => b.current_power - a.current_power) // Highest power first
      
      for (const load of loadsToShed) {
        if (powerSaved >= excessPower) break
        
        console.log(`⚡ Shedding ${load.name} (${load.current_power}W)`)
        const success = await turnOff(load.switch_entity!)
        
        if (success) {
          powerSaved += load.current_power
          state.shedLoads.push(load.id)
          actions.push(`⬇️ Apagado ${load.name} (${load.current_power}W)`)
          loadsAffected.push(load.name)
        }
      }
    }
    
    if (actions.length > 0) {
      state.lastAction = {
        timestamp: new Date().toISOString(),
        action: 'shed',
        loads: loadsAffected,
        reason: `Sobrecarga: ${state.totalPower}W > ${state.maxAvailable}W`,
      }
    }
    
  } else if (state.shedLoads.length > 0) {
    // Try to restore shed loads if we have headroom
    const headroom = state.maxAvailable - state.totalPower
    
    // Restore order: comfort first (higher priority), then accessory
    const restoreOrder: LoadPriority[] = ['comfort', 'accessory']
    
    for (const priority of restoreOrder) {
      const loadsToRestore = config.loads
        .filter(l => 
          l.priority === priority && 
          state.shedLoads.includes(l.id)
        )
        .sort((a, b) => a.max_power - b.max_power) // Lowest power first
      
      for (const load of loadsToRestore) {
        // Only restore if we have 80% headroom for safety
        if (load.max_power <= headroom * 0.8) {
          console.log(`⚡ Restoring ${load.name}`)
          const success = await turnOn(load.switch_entity!)
          
          if (success) {
            state.shedLoads = state.shedLoads.filter(id => id !== load.id)
            actions.push(`⬆️ Restaurado ${load.name}`)
            loadsAffected.push(load.name)
          }
        }
      }
    }
    
    if (actions.length > 0) {
      state.lastAction = {
        timestamp: new Date().toISOString(),
        action: 'restore',
        loads: loadsAffected,
        reason: `Headroom disponible: ${headroom}W`,
      }
    }
  }
  
  return { actions, loadsAffected }
}

/**
 * Get current state
 */
export function getLoadManagerState(): LoadManagerState {
  return state
}

/**
 * Force restore all shed loads
 */
export async function forceRestoreAll(): Promise<string[]> {
  const restored: string[] = []
  
  for (const loadId of [...state.shedLoads]) {
    const load = config.loads.find(l => l.id === loadId)
    if (load?.switch_entity) {
      const success = await turnOn(load.switch_entity)
      if (success) {
        state.shedLoads = state.shedLoads.filter(id => id !== loadId)
        restored.push(load.name)
      }
    }
  }
  
  if (restored.length > 0) {
    state.lastAction = {
      timestamp: new Date().toISOString(),
      action: 'restore',
      loads: restored,
      reason: 'Restauración manual forzada',
    }
  }
  
  return restored
}

/**
 * Enable/disable the load manager
 */
export function setEnabled(enabled: boolean): void {
  config.enabled = enabled
  saveConfig()
}

// Load config on module init
loadConfig()
state.maxAvailable = config.max_inverter_power * (1 - config.safety_margin / 100)

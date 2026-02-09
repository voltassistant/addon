/**
 * Configuration Management for VoltAssistant
 * Loads and manages configuration from data/config.json
 */

import fs from 'fs'
import path from 'path'

export interface SchedulerConfig {
  enabled: boolean
  interval_minutes: number
  retry_delay_seconds: number
  max_retries: number
}

export interface ThresholdsConfig {
  min_soc: number
  max_soc: number
  emergency_soc: number
  target_soc: number
  price_percentile_low: number
  price_percentile_high: number
  min_solar_watts_for_charge: number
}

export interface BatteryConfig {
  capacity_wh: number
  max_charge_rate_w: number
  max_discharge_rate_w: number
}

export interface HAEntitiesConfig {
  sensors: {
    battery_soc: string
    battery_power: string
    battery_state?: string
    solar_power: string
    grid_power: string
    load_power: string
    inverter_temp?: string
  }
  controls: {
    work_mode?: string
    grid_charge?: string
    battery_charge_limit?: string
    battery_discharge_limit?: string
    // Simplified control using Program 1
    program_1_soc?: string
    program_1_charging?: string
    energy_pattern?: string
    time_of_use?: string
    export_power?: string
  }
}

export interface HAConfig {
  entities: HAEntitiesConfig
  work_modes?: {
    self_use?: string
    selling_first?: string
    zero_export?: string
    export_first?: string
    zero_export_load?: string
    zero_export_ct?: string
  }
  charging_modes?: {
    disabled: string
    grid: string
    generator?: string
  }
}

// Load Management Types
export type LoadPriority = 'critical' | 'comfort' | 'accessory'

export interface LoadDevice {
  id: string
  name: string
  entity_id: string
  power_watts: number
  priority: LoadPriority
  can_shed: boolean
  min_off_minutes: number
}

export interface LoadsConfig {
  enabled: boolean
  check_interval_seconds: number
  max_inverter_power: number
  safety_margin_percent: number
  devices: LoadDevice[]
}

export interface AppConfig {
  scheduler: SchedulerConfig
  thresholds: ThresholdsConfig
  battery: BatteryConfig
  home_assistant: HAConfig
  loads: LoadsConfig
}

// Default configuration
const DEFAULT_CONFIG: AppConfig = {
  scheduler: {
    enabled: true,
    interval_minutes: 15,
    retry_delay_seconds: 60,
    max_retries: 3,
  },
  thresholds: {
    min_soc: 15,
    max_soc: 95,
    emergency_soc: 15,
    target_soc: 80,
    price_percentile_low: 20,
    price_percentile_high: 80,
    min_solar_watts_for_charge: 500,
  },
  battery: {
    capacity_wh: 10000,
    max_charge_rate_w: 3000,
    max_discharge_rate_w: 3000,
  },
  home_assistant: {
    entities: {
      sensors: {
        battery_soc: 'sensor.inverter_battery_soc',
        battery_power: 'sensor.inverter_battery_power',
        battery_state: 'sensor.inverter_battery_state',
        solar_power: 'sensor.inverter_pv_power',
        grid_power: 'sensor.inverter_grid_power',
        load_power: 'sensor.inverter_load_l1_power',
        inverter_temp: 'sensor.inverter_temperature',
      },
      controls: {
        work_mode: 'select.inverter_work_mode',
        // Simplified control using Program 1 (covers 00:00-23:59)
        program_1_soc: 'number.inverter_program_1_soc',
        program_1_charging: 'select.inverter_program_1_charging',
      },
    },
    work_modes: {
      export_first: 'Export First',
      zero_export_load: 'Zero Export To Load',
      zero_export_ct: 'Zero Export To CT',
    },
    charging_modes: {
      disabled: 'Disabled',
      grid: 'Grid',
      generator: 'Generator',
    },
  },
  loads: {
    enabled: false,
    check_interval_seconds: 30,
    max_inverter_power: 6000,
    safety_margin_percent: 10,
    devices: [],
  },
}

// Cached config
let cachedConfig: AppConfig | null = null
let configMtime: number = 0

function getConfigPath(): string {
  return path.join(__dirname, '..', 'data', 'config.json')
}

/**
 * Load configuration from file, create with defaults if doesn't exist
 */
export function loadConfig(): AppConfig {
  const configPath = getConfigPath()
  
  try {
    // Check if file exists
    if (!fs.existsSync(configPath)) {
      console.log('📝 Creando config.json con valores por defecto...')
      saveConfig(DEFAULT_CONFIG)
      cachedConfig = DEFAULT_CONFIG
      return DEFAULT_CONFIG
    }
    
    // Check if file changed since last load
    const stats = fs.statSync(configPath)
    if (cachedConfig && stats.mtimeMs === configMtime) {
      return cachedConfig
    }
    
    // Load and parse
    const content = fs.readFileSync(configPath, 'utf-8')
    const loaded = JSON.parse(content) as Partial<AppConfig>
    
    // Deep merge with defaults to ensure all fields exist
    cachedConfig = deepMerge(DEFAULT_CONFIG, loaded) as AppConfig
    configMtime = stats.mtimeMs
    
    return cachedConfig
  } catch (error) {
    console.error('Error loading config:', (error as Error).message)
    return DEFAULT_CONFIG
  }
}

/**
 * Save configuration to file
 */
export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath()
  const dataDir = path.dirname(configPath)
  
  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  cachedConfig = config
  configMtime = fs.statSync(configPath).mtimeMs
}

/**
 * Update specific configuration values
 */
export function updateConfig(updates: Partial<AppConfig>): AppConfig {
  const current = loadConfig()
  const updated = deepMerge(current, updates) as AppConfig
  saveConfig(updated)
  return updated
}

/**
 * Reset configuration to defaults
 */
export function resetConfig(): AppConfig {
  saveConfig(DEFAULT_CONFIG)
  return DEFAULT_CONFIG
}

/**
 * Get HA entities from config
 */
export function getHAEntities(): HAEntitiesConfig {
  const config = loadConfig()
  return config.home_assistant.entities
}

/**
 * Get scheduler config
 */
export function getSchedulerConfig(): SchedulerConfig {
  const config = loadConfig()
  return config.scheduler
}

/**
 * Get thresholds config
 */
export function getThresholdsConfig(): ThresholdsConfig {
  const config = loadConfig()
  return config.thresholds
}

/**
 * Get loads config
 * Always returns a valid LoadsConfig with devices as an array
 */
export function getLoadsConfig(): LoadsConfig {
  const config = loadConfig()
  
  // Defensive check: ensure devices is always an array
  if (!config.loads) {
    return DEFAULT_CONFIG.loads
  }
  
  if (!Array.isArray(config.loads.devices)) {
    config.loads.devices = []
  }
  
  return config.loads
}

/**
 * Update loads config
 */
export function updateLoadsConfig(updates: Partial<LoadsConfig>): LoadsConfig {
  const current = loadConfig()
  current.loads = { ...current.loads, ...updates }
  saveConfig(current)
  return current.loads
}

/**
 * Reload config from disk (clears cache)
 */
export function reloadConfig(): AppConfig {
  cachedConfig = null
  configMtime = 0
  return loadConfig()
}

/**
 * Deep merge two objects
 * Arrays are replaced entirely (not merged), objects are merged recursively
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target }
  
  for (const key of Object.keys(source)) {
    const sourceValue = source[key]
    const targetValue = target[key]
    
    // Skip undefined values
    if (sourceValue === undefined) {
      continue
    }
    
    // Arrays are replaced entirely, not merged
    if (Array.isArray(sourceValue)) {
      result[key] = [...sourceValue]
    }
    // Objects are merged recursively (but not arrays or null)
    else if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue)
    }
    // Primitives and null replace directly
    else {
      result[key] = sourceValue
    }
  }
  
  return result
}

/**
 * Validate configuration
 */
export function validateConfig(config: AppConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  
  // Scheduler validation
  if (config.scheduler.interval_minutes < 1) {
    errors.push('scheduler.interval_minutes debe ser >= 1')
  }
  if (config.scheduler.interval_minutes > 60) {
    errors.push('scheduler.interval_minutes debe ser <= 60')
  }
  
  // Thresholds validation
  if (config.thresholds.min_soc < 0 || config.thresholds.min_soc > 100) {
    errors.push('thresholds.min_soc debe estar entre 0 y 100')
  }
  if (config.thresholds.max_soc < config.thresholds.min_soc) {
    errors.push('thresholds.max_soc debe ser >= min_soc')
  }
  if (config.thresholds.emergency_soc > config.thresholds.min_soc) {
    errors.push('thresholds.emergency_soc debe ser <= min_soc')
  }
  if (config.thresholds.target_soc > config.thresholds.max_soc) {
    errors.push('thresholds.target_soc debe ser <= max_soc')
  }
  if (config.thresholds.price_percentile_low >= config.thresholds.price_percentile_high) {
    errors.push('thresholds.price_percentile_low debe ser < price_percentile_high')
  }
  
  // Battery validation
  if (config.battery.capacity_wh < 1000) {
    errors.push('battery.capacity_wh debe ser >= 1000')
  }
  
  // HA entities validation
  const { sensors, controls } = config.home_assistant.entities
  if (!sensors.battery_soc) errors.push('Falta entity: sensors.battery_soc')
  if (!sensors.battery_power) errors.push('Falta entity: sensors.battery_power')
  if (!sensors.solar_power) errors.push('Falta entity: sensors.solar_power')
  // Simplified control requires program_1 entities
  if (!controls.program_1_soc && !controls.grid_charge) {
    errors.push('Falta entity: controls.program_1_soc o controls.grid_charge')
  }
  if (!controls.program_1_charging && !controls.grid_charge) {
    errors.push('Falta entity: controls.program_1_charging o controls.grid_charge')
  }
  
  // Loads validation
  if (config.loads.enabled) {
    if (config.loads.max_inverter_power < 1000) {
      errors.push('loads.max_inverter_power debe ser >= 1000')
    }
    if (config.loads.safety_margin_percent < 0 || config.loads.safety_margin_percent > 50) {
      errors.push('loads.safety_margin_percent debe estar entre 0 y 50')
    }
    for (const device of config.loads.devices) {
      if (!device.id) errors.push('Load device missing id')
      if (!device.entity_id) errors.push(`Load ${device.id} missing entity_id`)
      if (!['critical', 'comfort', 'accessory'].includes(device.priority)) {
        errors.push(`Load ${device.id} has invalid priority: ${device.priority}`)
      }
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
  }
}

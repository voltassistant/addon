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
    solar_power: string
    grid_power: string
    load_power: string
    inverter_temp?: string
  }
  controls: {
    work_mode: string
    grid_charge: string
    battery_charge_limit?: string
    battery_discharge_limit?: string
  }
}

export interface HAConfig {
  entities: HAEntitiesConfig
  work_modes: {
    self_use: string
    selling_first: string
    zero_export: string
  }
}

export interface AppConfig {
  scheduler: SchedulerConfig
  thresholds: ThresholdsConfig
  battery: BatteryConfig
  home_assistant: HAConfig
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
        battery_soc: 'sensor.deye_battery_soc',
        battery_power: 'sensor.deye_battery_power',
        solar_power: 'sensor.deye_pv_power',
        grid_power: 'sensor.deye_grid_power',
        load_power: 'sensor.deye_load_power',
        inverter_temp: 'sensor.deye_inverter_temperature',
      },
      controls: {
        work_mode: 'select.deye_work_mode',
        grid_charge: 'switch.deye_grid_charge',
        battery_charge_limit: 'number.deye_battery_charge_limit',
        battery_discharge_limit: 'number.deye_battery_discharge_limit',
      },
    },
    work_modes: {
      self_use: 'self_use',
      selling_first: 'selling_first',
      zero_export: 'zero_export',
    },
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
 * Reload config from disk (clears cache)
 */
export function reloadConfig(): AppConfig {
  cachedConfig = null
  configMtime = 0
  return loadConfig()
}

/**
 * Deep merge two objects
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target }
  
  for (const key of Object.keys(source)) {
    if (source[key] instanceof Object && key in target && target[key] instanceof Object) {
      result[key] = deepMerge(target[key], source[key])
    } else if (source[key] !== undefined) {
      result[key] = source[key]
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
  if (!controls.work_mode) errors.push('Falta entity: controls.work_mode')
  if (!controls.grid_charge) errors.push('Falta entity: controls.grid_charge')
  
  return {
    valid: errors.length === 0,
    errors,
  }
}

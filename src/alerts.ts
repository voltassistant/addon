/**
 * Alert Configuration and Management
 * Defines thresholds and manages alert state
 */

export interface AlertConfig {
  battery: {
    lowSoc: number // Alert when SOC below this (%)
    criticalSoc: number // Critical alert (%)
    highTemp: number // Inverter temperature alert (°C)
  }
  price: {
    highPrice: number // Alert when price above this (€/kWh)
    lowPrice: number // Good price notification (€/kWh)
  }
  solar: {
    lowProduction: number // Alert when daily production below (kWh)
  }
}

export interface Alert {
  id: string
  type: 'battery_low' | 'battery_critical' | 'temp_high' | 'price_high' | 'price_low' | 'solar_low'
  severity: 'info' | 'warning' | 'critical'
  message: string
  timestamp: string
  acknowledged: boolean
}

// Default configuration
const DEFAULT_CONFIG: AlertConfig = {
  battery: {
    lowSoc: 20,
    criticalSoc: 10,
    highTemp: 50,
  },
  price: {
    highPrice: 0.20,
    lowPrice: 0.08,
  },
  solar: {
    lowProduction: 3,
  },
}

// In-memory alert state (would be persisted in production)
let currentConfig: AlertConfig = { ...DEFAULT_CONFIG }
let activeAlerts: Alert[] = []
let alertHistory: Alert[] = []

export function getConfig(): AlertConfig {
  return { ...currentConfig }
}

export function setConfig(config: Partial<AlertConfig>): AlertConfig {
  currentConfig = {
    battery: { ...currentConfig.battery, ...config.battery },
    price: { ...currentConfig.price, ...config.price },
    solar: { ...currentConfig.solar, ...config.solar },
  }
  return currentConfig
}

export function resetConfig(): AlertConfig {
  currentConfig = { ...DEFAULT_CONFIG }
  return currentConfig
}

export function getActiveAlerts(): Alert[] {
  return [...activeAlerts]
}

export function getAlertHistory(limit: number = 50): Alert[] {
  return alertHistory.slice(-limit)
}

export function acknowledgeAlert(id: string): boolean {
  const alert = activeAlerts.find(a => a.id === id)
  if (alert) {
    alert.acknowledged = true
    return true
  }
  return false
}

export function clearAlert(id: string): boolean {
  const index = activeAlerts.findIndex(a => a.id === id)
  if (index !== -1) {
    const removed = activeAlerts.splice(index, 1)[0]
    alertHistory.push(removed)
    return true
  }
  return false
}

function createAlert(
  type: Alert['type'],
  severity: Alert['severity'],
  message: string
): Alert {
  const alert: Alert = {
    id: `${type}-${Date.now()}`,
    type,
    severity,
    message,
    timestamp: new Date().toISOString(),
    acknowledged: false,
  }
  
  // Check if similar alert already exists
  const existing = activeAlerts.find(a => a.type === type && !a.acknowledged)
  if (!existing) {
    activeAlerts.push(alert)
  }
  
  return alert
}

export function checkAlerts(data: {
  batterySoc: number
  inverterTemp: number
  currentPrice: number
  dailySolarKwh: number
}): Alert[] {
  const newAlerts: Alert[] = []
  const config = currentConfig
  
  // Battery alerts
  if (data.batterySoc <= config.battery.criticalSoc) {
    newAlerts.push(createAlert(
      'battery_critical',
      'critical',
      `🔴 Batería crítica: ${data.batterySoc}% - ¡Carga inmediata recomendada!`
    ))
  } else if (data.batterySoc <= config.battery.lowSoc) {
    newAlerts.push(createAlert(
      'battery_low',
      'warning',
      `🟡 Batería baja: ${data.batterySoc}% - Considera cargar desde red`
    ))
  }
  
  // Temperature alert
  if (data.inverterTemp >= config.battery.highTemp) {
    newAlerts.push(createAlert(
      'temp_high',
      'warning',
      `🌡️ Temperatura alta: ${data.inverterTemp}°C - Verifica ventilación`
    ))
  }
  
  // Price alerts
  if (data.currentPrice >= config.price.highPrice) {
    newAlerts.push(createAlert(
      'price_high',
      'warning',
      `💶 Precio alto: ${(data.currentPrice * 100).toFixed(1)}¢/kWh - Usa batería si posible`
    ))
  } else if (data.currentPrice <= config.price.lowPrice) {
    newAlerts.push(createAlert(
      'price_low',
      'info',
      `💚 Precio bajo: ${(data.currentPrice * 100).toFixed(1)}¢/kWh - Buen momento para cargar`
    ))
  }
  
  // Solar production alert (checked at end of day)
  const hour = new Date().getHours()
  if (hour >= 18 && data.dailySolarKwh < config.solar.lowProduction) {
    newAlerts.push(createAlert(
      'solar_low',
      'info',
      `☁️ Producción solar baja hoy: ${data.dailySolarKwh} kWh`
    ))
  }
  
  return newAlerts.filter(a => !activeAlerts.some(
    existing => existing.type === a.type && existing.id !== a.id
  ))
}

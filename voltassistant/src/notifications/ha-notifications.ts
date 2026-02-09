/**
 * Home Assistant Enhanced Notifications
 * Actionable notifications with persistent, grouping, and actions
 */

import { getConfig } from '../config'

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical'

export interface NotificationAction {
  action: string
  title: string
  uri?: string
  icon?: string
  destructive?: boolean
  authenticationRequired?: boolean
}

export interface HANotification {
  title: string
  message: string
  data?: {
    // Presentation
    group?: string
    tag?: string
    persistent?: boolean
    sticky?: boolean
    
    // Priority
    priority?: NotificationPriority
    importance?: 'min' | 'low' | 'default' | 'high' | 'max'
    channel?: string
    
    // Actions
    actions?: NotificationAction[]
    
    // Media
    image?: string
    video?: string
    icon_url?: string
    
    // Android specific
    notification_icon?: string
    color?: string
    vibrationPattern?: number[]
    ledColor?: string
    
    // iOS specific
    push?: {
      sound?: string | { name: string; critical?: number; volume?: number }
      badge?: number
      interruption_level?: 'passive' | 'active' | 'time-sensitive' | 'critical'
      presentation_options?: ('alert' | 'badge' | 'sound')[]
    }
    
    // TTS
    tts_text?: string
    
    // Timeout
    timeout?: number
    
    // Entity context
    entity_id?: string
    
    // Custom data
    [key: string]: any
  }
}

export interface NotificationTarget {
  type: 'device' | 'group' | 'all'
  deviceId?: string
  groupName?: string
}

// HA WebSocket connection (simplified - in production use proper HA API client)
let haConnection: { url: string; token: string } | null = null

export function configureHA(url: string, token: string): void {
  haConnection = { url, token }
}

/**
 * Send notification via HA
 */
export async function sendHANotification(
  notification: HANotification,
  target: NotificationTarget = { type: 'all' }
): Promise<boolean> {
  const config = getConfig()
  const haConfig = config.home_assistant as any
  const haUrl = haConnection?.url || haConfig?.url
  const haToken = haConnection?.token || haConfig?.token
  
  if (!haUrl || !haToken) {
    console.error('Home Assistant not configured')
    return false
  }
  
  try {
    let service = 'notify.notify'
    
    if (target.type === 'device' && target.deviceId) {
      service = `notify.mobile_app_${target.deviceId}`
    } else if (target.type === 'group' && target.groupName) {
      service = `notify.${target.groupName}`
    }
    
    const response = await fetch(`${haUrl}/api/services/${service.replace('.', '/')}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${haToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(notification),
    })
    
    if (!response.ok) {
      throw new Error(`HA API error: ${response.status}`)
    }
    
    console.log(`HA notification sent: ${notification.title}`)
    return true
  } catch (error) {
    console.error('Failed to send HA notification:', error)
    return false
  }
}

/**
 * Fire HA event (for automations)
 */
export async function fireHAEvent(eventType: string, eventData: Record<string, any>): Promise<boolean> {
  const config = getConfig()
  const haConfig = config.home_assistant as any
  const haUrl = haConnection?.url || haConfig?.url
  const haToken = haConnection?.token || haConfig?.token
  
  if (!haUrl || !haToken) {
    console.error('Home Assistant not configured')
    return false
  }
  
  try {
    const response = await fetch(`${haUrl}/api/events/${eventType}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${haToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData),
    })
    
    if (!response.ok) {
      throw new Error(`HA API error: ${response.status}`)
    }
    
    return true
  } catch (error) {
    console.error('Failed to fire HA event:', error)
    return false
  }
}

// ============== Pre-built Notification Templates ==============

/**
 * Battery low notification with actions
 */
export function batteryLowNotification(soc: number, estimatedHours: number): HANotification {
  return {
    title: '🔋 Batería Baja',
    message: `Batería al ${soc}%. Tiempo restante estimado: ${estimatedHours}h`,
    data: {
      group: 'voltassistant_battery',
      tag: 'battery_low',
      priority: 'high',
      importance: 'high',
      sticky: true,
      actions: [
        {
          action: 'CHARGE_FROM_GRID',
          title: '⚡ Cargar desde red',
          icon: 'mdi:transmission-tower',
        },
        {
          action: 'ENABLE_SAVINGS_MODE',
          title: '💡 Modo ahorro',
          icon: 'mdi:leaf',
        },
        {
          action: 'DISMISS',
          title: 'Ignorar',
        },
      ],
      push: {
        sound: { name: 'default', critical: 0, volume: 0.8 },
        interruption_level: 'time-sensitive',
      },
      color: '#FFA500',
      entity_id: 'sensor.voltassistant_battery_soc',
    },
  }
}

/**
 * Critical battery notification
 */
export function batteryCriticalNotification(soc: number): HANotification {
  return {
    title: '🚨 ¡Batería Crítica!',
    message: `¡URGENTE! Batería al ${soc}%. Cargando desde red automáticamente.`,
    data: {
      group: 'voltassistant_critical',
      tag: 'battery_critical',
      priority: 'critical',
      importance: 'max',
      persistent: true,
      sticky: true,
      actions: [
        {
          action: 'VIEW_DASHBOARD',
          title: '📊 Ver Dashboard',
          uri: '/lovelace/energy',
        },
        {
          action: 'CALL_SUPPORT',
          title: '📞 Llamar soporte',
          icon: 'mdi:phone',
        },
      ],
      push: {
        sound: { name: 'default', critical: 1, volume: 1.0 },
        interruption_level: 'critical',
      },
      vibrationPattern: [0, 500, 100, 500, 100, 500],
      color: '#FF0000',
      ledColor: 'red',
    },
  }
}

/**
 * Price opportunity notification
 */
export function priceOpportunityNotification(
  price: number, 
  avgPrice: number,
  recommendation: string
): HANotification {
  const savingsPercent = Math.round((1 - price / avgPrice) * 100)
  
  return {
    title: '💚 ¡Precio Bajo!',
    message: `${(price * 100).toFixed(1)}¢/kWh (${savingsPercent}% bajo media). ${recommendation}`,
    data: {
      group: 'voltassistant_prices',
      tag: 'price_opportunity',
      priority: 'normal',
      actions: [
        {
          action: 'START_CHARGING',
          title: '⚡ Empezar carga',
          icon: 'mdi:battery-charging',
        },
        {
          action: 'SCHEDULE_APPLIANCES',
          title: '🔌 Programar',
          icon: 'mdi:calendar-clock',
        },
        {
          action: 'DISMISS',
          title: 'OK',
        },
      ],
      color: '#22C55E',
      timeout: 3600, // Auto-dismiss after 1 hour
    },
  }
}

/**
 * Solar production alert
 */
export function solarProductionNotification(
  currentKw: number,
  dailyKwh: number,
  status: 'high' | 'low' | 'peak'
): HANotification {
  const titles = {
    high: '☀️ Alta Producción Solar',
    low: '☁️ Baja Producción Solar',
    peak: '🌟 ¡Pico de Producción!',
  }
  
  const messages = {
    high: `Produciendo ${currentKw.toFixed(1)} kW. Hoy: ${dailyKwh.toFixed(1)} kWh`,
    low: `Solo ${currentKw.toFixed(1)} kW. Considera usar batería.`,
    peak: `¡Máxima producción! ${currentKw.toFixed(1)} kW. Aprovecha para cargar.`,
  }
  
  return {
    title: titles[status],
    message: messages[status],
    data: {
      group: 'voltassistant_solar',
      tag: 'solar_production',
      priority: status === 'peak' ? 'high' : 'normal',
      image: '/local/voltassistant/solar_chart.png',
      actions: status === 'peak' ? [
        {
          action: 'BOOST_CHARGING',
          title: '⚡ Carga rápida',
        },
        {
          action: 'RUN_HIGH_POWER',
          title: '🔌 Electrodomésticos',
        },
      ] : undefined,
      color: status === 'low' ? '#6B7280' : '#F59E0B',
    },
  }
}

/**
 * Daily summary notification
 */
export function dailySummaryNotification(summary: {
  solarKwh: number
  consumedKwh: number
  gridKwh: number
  savedEuros: number
  selfSufficiency: number
}): HANotification {
  return {
    title: '📊 Resumen del Día',
    message: `Solar: ${summary.solarKwh.toFixed(1)} kWh | Autoconsumo: ${summary.selfSufficiency}% | Ahorro: ${summary.savedEuros.toFixed(2)}€`,
    data: {
      group: 'voltassistant_daily',
      tag: 'daily_summary',
      priority: 'low',
      persistent: true,
      actions: [
        {
          action: 'VIEW_DETAILS',
          title: '📈 Ver detalles',
          uri: '/lovelace/energy',
        },
        {
          action: 'SHARE',
          title: '📤 Compartir',
          icon: 'mdi:share',
        },
      ],
      push: {
        badge: Math.round(summary.selfSufficiency),
      },
      color: summary.selfSufficiency >= 80 ? '#22C55E' : '#3B82F6',
    },
  }
}

/**
 * System alert notification
 */
export function systemAlertNotification(
  alertType: 'inverter_offline' | 'high_temp' | 'connection_lost' | 'firmware_update',
  details: string
): HANotification {
  const configs = {
    inverter_offline: {
      title: '⚠️ Inversor Sin Conexión',
      priority: 'critical' as const,
      color: '#EF4444',
    },
    high_temp: {
      title: '🌡️ Temperatura Alta',
      priority: 'high' as const,
      color: '#F97316',
    },
    connection_lost: {
      title: '📡 Conexión Perdida',
      priority: 'high' as const,
      color: '#EF4444',
    },
    firmware_update: {
      title: '🔄 Actualización Disponible',
      priority: 'low' as const,
      color: '#3B82F6',
    },
  }
  
  const config = configs[alertType]
  
  return {
    title: config.title,
    message: details,
    data: {
      group: 'voltassistant_system',
      tag: `system_${alertType}`,
      priority: config.priority,
      importance: config.priority === 'critical' ? 'max' : 'high',
      persistent: config.priority === 'critical',
      sticky: config.priority === 'critical',
      actions: [
        {
          action: 'VIEW_DIAGNOSTICS',
          title: '🔧 Diagnóstico',
          uri: '/lovelace/voltassistant-diagnostics',
        },
        ...(alertType === 'firmware_update' ? [{
          action: 'UPDATE_NOW',
          title: '⬆️ Actualizar',
        }] : []),
        {
          action: 'ACKNOWLEDGE',
          title: 'Entendido',
        },
      ],
      push: {
        interruption_level: config.priority === 'critical' ? 'critical' : 'active',
      },
      color: config.color,
    },
  }
}

// ============== Action Handler ==============

export type ActionHandler = (action: string, data?: any) => Promise<void>

const actionHandlers: Map<string, ActionHandler> = new Map()

export function registerActionHandler(action: string, handler: ActionHandler): void {
  actionHandlers.set(action, handler)
}

export async function handleAction(action: string, data?: any): Promise<boolean> {
  const handler = actionHandlers.get(action)
  if (!handler) {
    console.warn(`No handler for action: ${action}`)
    return false
  }
  
  try {
    await handler(action, data)
    return true
  } catch (error) {
    console.error(`Action handler error for ${action}:`, error)
    return false
  }
}

// Register default handlers
registerActionHandler('CHARGE_FROM_GRID', async () => {
  await fireHAEvent('voltassistant_command', { command: 'charge_from_grid' })
})

registerActionHandler('ENABLE_SAVINGS_MODE', async () => {
  await fireHAEvent('voltassistant_command', { command: 'savings_mode' })
})

registerActionHandler('START_CHARGING', async () => {
  await fireHAEvent('voltassistant_command', { command: 'start_charging' })
})

registerActionHandler('BOOST_CHARGING', async () => {
  await fireHAEvent('voltassistant_command', { command: 'boost_charging' })
})

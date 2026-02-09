/**
 * Critical Alert Escalation System
 * Multi-tier notification with acknowledgment and escalation
 */

import { sendHANotification, batteryCriticalNotification, systemAlertNotification } from './ha-notifications'
import { sendToAdmin, broadcastTelegram, formatCriticalAlert } from './telegram-bot'
import { sendDiscordWebhook, criticalAlertEmbed, alertAckButtons } from './discord-bot'
import { getConfig } from '../config'

export type EscalationLevel = 'info' | 'warning' | 'critical' | 'emergency'

export interface EscalationPolicy {
  level: EscalationLevel
  channels: ('ha' | 'telegram' | 'discord' | 'email' | 'sms' | 'phone')[]
  delayMinutes: number
  requireAck: boolean
}

export interface EscalationConfig {
  policies: EscalationPolicy[]
  escalationIntervalMinutes: number
  maxEscalations: number
  quietHours?: {
    start: number // 0-23
    end: number // 0-23
    bypassForEmergency: boolean
  }
  contacts: {
    primary: ContactInfo
    secondary?: ContactInfo
    emergency?: ContactInfo
  }
}

export interface ContactInfo {
  name: string
  telegramChatId?: string
  discordUserId?: string
  email?: string
  phone?: string
}

export interface EscalatingAlert {
  id: string
  type: string
  severity: EscalationLevel
  title: string
  message: string
  metadata?: Record<string, any>
  createdAt: Date
  acknowledgedAt?: Date
  acknowledgedBy?: string
  escalationLevel: number
  lastEscalatedAt?: Date
  nextEscalationAt?: Date
  resolved: boolean
  resolvedAt?: Date
  history: EscalationEvent[]
}

export interface EscalationEvent {
  timestamp: Date
  level: number
  channels: string[]
  delivered: string[]
  failed: string[]
}

// Default escalation policies
const DEFAULT_POLICIES: EscalationPolicy[] = [
  {
    level: 'info',
    channels: ['ha'],
    delayMinutes: 0,
    requireAck: false,
  },
  {
    level: 'warning',
    channels: ['ha', 'telegram'],
    delayMinutes: 0,
    requireAck: false,
  },
  {
    level: 'critical',
    channels: ['ha', 'telegram', 'discord'],
    delayMinutes: 0,
    requireAck: true,
  },
  {
    level: 'emergency',
    channels: ['ha', 'telegram', 'discord', 'phone'],
    delayMinutes: 0,
    requireAck: true,
  },
]

// Storage
const activeAlerts: Map<string, EscalatingAlert> = new Map()
let escalationConfig: EscalationConfig = {
  policies: DEFAULT_POLICIES,
  escalationIntervalMinutes: 15,
  maxEscalations: 4,
  contacts: {
    primary: { name: 'Admin' },
  },
}

function generateId(): string {
  return `esc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Configure escalation settings
 */
export function configureEscalation(config: Partial<EscalationConfig>): void {
  escalationConfig = {
    ...escalationConfig,
    ...config,
    policies: config.policies || escalationConfig.policies,
    contacts: { ...escalationConfig.contacts, ...config.contacts },
  }
}

/**
 * Check if within quiet hours
 */
function isQuietHours(): boolean {
  if (!escalationConfig.quietHours) return false
  
  const hour = new Date().getHours()
  const { start, end } = escalationConfig.quietHours
  
  // Handle overnight quiet hours (e.g., 22:00 - 08:00)
  if (start > end) {
    return hour >= start || hour < end
  }
  return hour >= start && hour < end
}

/**
 * Get policy for severity level
 */
function getPolicy(level: EscalationLevel): EscalationPolicy {
  return escalationConfig.policies.find(p => p.level === level) || DEFAULT_POLICIES[0]
}

/**
 * Send notification to a specific channel
 */
async function sendToChannel(
  channel: string,
  alert: EscalatingAlert,
  escalationLevel: number
): Promise<boolean> {
  const urgencyPrefix = escalationLevel > 0 ? `[Escalation ${escalationLevel}] ` : ''
  
  try {
    switch (channel) {
      case 'ha':
        if (alert.severity === 'critical' || alert.severity === 'emergency') {
          return await sendHANotification(
            systemAlertNotification(alert.type as any, alert.message)
          )
        }
        return await sendHANotification({
          title: urgencyPrefix + alert.title,
          message: alert.message,
          data: {
            priority: alert.severity,
            tag: `escalation_${alert.id}`,
            persistent: alert.severity !== 'info',
          },
        })
        
      case 'telegram':
        const telegramText = formatCriticalAlert({
          type: urgencyPrefix + alert.type,
          message: alert.message,
          timestamp: new Date().toLocaleString('es-ES'),
        })
        
        if (alert.severity === 'emergency' || escalationLevel > 0) {
          return await sendToAdmin(telegramText)
        }
        return (await broadcastTelegram(telegramText)) > 0
        
      case 'discord':
        return await sendDiscordWebhook({
          embeds: [criticalAlertEmbed({
            type: urgencyPrefix + alert.type,
            severity: alert.severity === 'emergency' ? 'critical' : alert.severity as any,
            message: alert.message,
            recommendation: 'Requiere atención inmediata',
          })],
          components: [alertAckButtons(alert.id)],
        })
        
      case 'email':
        // Email integration would go here
        console.log(`[EMAIL] ${alert.title}: ${alert.message}`)
        return true
        
      case 'sms':
        // SMS integration (Twilio, etc.) would go here
        console.log(`[SMS] ${alert.title}: ${alert.message}`)
        return true
        
      case 'phone':
        // Phone call integration would go here
        console.log(`[PHONE CALL] Emergency: ${alert.title}`)
        return true
        
      default:
        console.warn(`Unknown channel: ${channel}`)
        return false
    }
  } catch (error) {
    console.error(`Failed to send to ${channel}:`, error)
    return false
  }
}

/**
 * Create and send escalating alert
 */
export async function createEscalatingAlert(params: {
  type: string
  severity: EscalationLevel
  title: string
  message: string
  metadata?: Record<string, any>
}): Promise<EscalatingAlert> {
  const policy = getPolicy(params.severity)
  
  // Check quiet hours for non-emergency
  if (isQuietHours() && params.severity !== 'emergency') {
    if (!escalationConfig.quietHours?.bypassForEmergency) {
      console.log(`Alert suppressed during quiet hours: ${params.title}`)
    }
  }
  
  const alert: EscalatingAlert = {
    id: generateId(),
    ...params,
    createdAt: new Date(),
    escalationLevel: 0,
    resolved: false,
    history: [],
  }
  
  // Calculate next escalation time if ack required
  if (policy.requireAck) {
    alert.nextEscalationAt = new Date(
      Date.now() + escalationConfig.escalationIntervalMinutes * 60 * 1000
    )
  }
  
  activeAlerts.set(alert.id, alert)
  
  // Send initial notifications
  await escalateAlert(alert)
  
  return alert
}

/**
 * Escalate alert to next level
 */
async function escalateAlert(alert: EscalatingAlert): Promise<void> {
  const policy = getPolicy(alert.severity)
  const channels = policy.channels
  
  // For escalation levels, add more urgent channels
  const escalatedChannels = [...channels]
  if (alert.escalationLevel > 0) {
    // Add email at level 1
    if (alert.escalationLevel >= 1 && !escalatedChannels.includes('email')) {
      escalatedChannels.push('email')
    }
    // Add SMS at level 2
    if (alert.escalationLevel >= 2 && !escalatedChannels.includes('sms')) {
      escalatedChannels.push('sms')
    }
    // Add phone at level 3
    if (alert.escalationLevel >= 3 && !escalatedChannels.includes('phone')) {
      escalatedChannels.push('phone')
    }
  }
  
  const event: EscalationEvent = {
    timestamp: new Date(),
    level: alert.escalationLevel,
    channels: escalatedChannels,
    delivered: [],
    failed: [],
  }
  
  // Send to all channels
  for (const channel of escalatedChannels) {
    const success = await sendToChannel(channel, alert, alert.escalationLevel)
    if (success) {
      event.delivered.push(channel)
    } else {
      event.failed.push(channel)
    }
  }
  
  alert.lastEscalatedAt = new Date()
  alert.history.push(event)
  
  console.log(`Alert ${alert.id} escalated to level ${alert.escalationLevel}`)
}

/**
 * Acknowledge alert
 */
export function acknowledgeEscalatingAlert(
  alertId: string,
  acknowledgedBy: string
): boolean {
  const alert = activeAlerts.get(alertId)
  if (!alert || alert.resolved) return false
  
  alert.acknowledgedAt = new Date()
  alert.acknowledgedBy = acknowledgedBy
  alert.nextEscalationAt = undefined
  
  console.log(`Alert ${alertId} acknowledged by ${acknowledgedBy}`)
  return true
}

/**
 * Resolve alert
 */
export function resolveEscalatingAlert(
  alertId: string,
  resolvedBy?: string
): boolean {
  const alert = activeAlerts.get(alertId)
  if (!alert) return false
  
  alert.resolved = true
  alert.resolvedAt = new Date()
  alert.nextEscalationAt = undefined
  
  if (!alert.acknowledgedAt) {
    alert.acknowledgedAt = new Date()
    alert.acknowledgedBy = resolvedBy || 'system'
  }
  
  console.log(`Alert ${alertId} resolved`)
  return true
}

/**
 * Get active escalating alerts
 */
export function getEscalatingAlerts(
  options: { unacknowledgedOnly?: boolean; severity?: EscalationLevel } = {}
): EscalatingAlert[] {
  let alerts = Array.from(activeAlerts.values()).filter(a => !a.resolved)
  
  if (options.unacknowledgedOnly) {
    alerts = alerts.filter(a => !a.acknowledgedAt)
  }
  
  if (options.severity) {
    alerts = alerts.filter(a => a.severity === options.severity)
  }
  
  return alerts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

/**
 * Process escalations (called periodically)
 */
export async function processEscalations(): Promise<number> {
  const now = new Date()
  let escalated = 0
  
  for (const alert of activeAlerts.values()) {
    // Skip resolved or acknowledged alerts
    if (alert.resolved || alert.acknowledgedAt) continue
    
    // Skip if not yet time to escalate
    if (!alert.nextEscalationAt || alert.nextEscalationAt > now) continue
    
    // Skip if max escalations reached
    if (alert.escalationLevel >= escalationConfig.maxEscalations) {
      console.warn(`Alert ${alert.id} reached max escalations`)
      continue
    }
    
    // Escalate
    alert.escalationLevel++
    alert.nextEscalationAt = new Date(
      now.getTime() + escalationConfig.escalationIntervalMinutes * 60 * 1000
    )
    
    await escalateAlert(alert)
    escalated++
  }
  
  return escalated
}

/**
 * Get escalation statistics
 */
export function getEscalationStats(): {
  active: number
  unacknowledged: number
  byLevel: Record<EscalationLevel, number>
  avgResponseTimeMinutes: number
} {
  const alerts = Array.from(activeAlerts.values())
  const active = alerts.filter(a => !a.resolved)
  const acknowledged = alerts.filter(a => a.acknowledgedAt)
  
  // Calculate average response time
  let totalResponseTime = 0
  let responseCount = 0
  for (const alert of acknowledged) {
    if (alert.acknowledgedAt) {
      totalResponseTime += alert.acknowledgedAt.getTime() - alert.createdAt.getTime()
      responseCount++
    }
  }
  
  const byLevel: Record<EscalationLevel, number> = {
    info: 0,
    warning: 0,
    critical: 0,
    emergency: 0,
  }
  
  for (const alert of active) {
    byLevel[alert.severity]++
  }
  
  return {
    active: active.length,
    unacknowledged: active.filter(a => !a.acknowledgedAt).length,
    byLevel,
    avgResponseTimeMinutes: responseCount > 0 
      ? Math.round(totalResponseTime / responseCount / 60000) 
      : 0,
  }
}

/**
 * Clean up old resolved alerts
 */
export function cleanupResolvedAlerts(olderThanHours: number = 24): number {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000)
  let cleaned = 0
  
  for (const [id, alert] of activeAlerts) {
    if (alert.resolved && alert.resolvedAt && alert.resolvedAt < cutoff) {
      activeAlerts.delete(id)
      cleaned++
    }
  }
  
  return cleaned
}

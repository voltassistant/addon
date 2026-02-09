/**
 * Notifications Module
 * Central export for all notification integrations
 */

// Home Assistant Enhanced Notifications
export {
  configureHA,
  sendHANotification,
  fireHAEvent,
  batteryLowNotification,
  batteryCriticalNotification,
  priceOpportunityNotification,
  solarProductionNotification,
  dailySummaryNotification,
  systemAlertNotification,
  registerActionHandler,
  handleAction,
  type HANotification,
  type NotificationAction,
  type NotificationTarget,
  type NotificationPriority,
} from './ha-notifications'

// Telegram Bot Integration
export {
  configureTelegram,
  sendTelegramMessage,
  broadcastTelegram,
  sendToAdmin,
  formatBatteryStatus,
  formatPriceAlert,
  formatDailySummary,
  formatCriticalAlert,
  registerCommand as registerTelegramCommand,
  handleCommand as handleTelegramCommand,
  handleWebhookUpdate,
  type TelegramConfig,
  type TelegramMessage,
  type TelegramUpdate,
} from './telegram-bot'

// Discord Bot Integration
export {
  configureDiscord,
  sendDiscordWebhook,
  sendDiscordMessage,
  batteryStatusEmbed,
  priceAlertEmbed,
  criticalAlertEmbed,
  dailySummaryEmbed,
  batteryControlButtons,
  alertAckButtons,
  registerCommand as registerDiscordCommand,
  handleCommand as handleDiscordCommand,
  handleInteraction,
  type DiscordConfig,
  type DiscordMessage,
  type DiscordEmbed,
  type DiscordInteraction,
} from './discord-bot'

// Escalation System
export {
  configureEscalation,
  createEscalatingAlert,
  acknowledgeEscalatingAlert,
  resolveEscalatingAlert,
  getEscalatingAlerts,
  processEscalations,
  getEscalationStats,
  cleanupResolvedAlerts,
  type EscalationLevel,
  type EscalationPolicy,
  type EscalationConfig,
  type EscalatingAlert,
  type ContactInfo,
} from './escalation'

// ============== Unified Notification Interface ==============

import { getConfig } from '../config'
import { sendHANotification, batteryLowNotification, batteryCriticalNotification, priceOpportunityNotification } from './ha-notifications'
import { broadcastTelegram, formatBatteryStatus, formatPriceAlert } from './telegram-bot'
import { sendDiscordWebhook, batteryStatusEmbed, priceAlertEmbed } from './discord-bot'
import { createEscalatingAlert, type EscalationLevel } from './escalation'

export interface NotificationOptions {
  channels?: ('ha' | 'telegram' | 'discord' | 'all')[]
  escalate?: boolean
  priority?: 'low' | 'normal' | 'high' | 'critical'
}

/**
 * Send battery status notification to all configured channels
 */
export async function notifyBatteryStatus(data: {
  soc: number
  power: number
  temp: number
  mode: string
  trend?: 'charging' | 'discharging' | 'idle'
}, options: NotificationOptions = {}): Promise<void> {
  const channels = options.channels || ['all']
  const sendToAll = channels.includes('all')
  
  const results: Promise<any>[] = []
  
  if (sendToAll || channels.includes('ha')) {
    if (data.soc <= 10) {
      results.push(sendHANotification(batteryCriticalNotification(data.soc)))
    } else if (data.soc <= 20) {
      results.push(sendHANotification(batteryLowNotification(data.soc, Math.floor(data.soc / 5))))
    }
  }
  
  if (sendToAll || channels.includes('telegram')) {
    results.push(broadcastTelegram(formatBatteryStatus(data)))
  }
  
  if (sendToAll || channels.includes('discord')) {
    results.push(sendDiscordWebhook({
      embeds: [batteryStatusEmbed({ ...data, trend: data.trend || 'idle' })],
    }))
  }
  
  await Promise.allSettled(results)
}

/**
 * Send price alert to all configured channels
 */
export async function notifyPriceAlert(data: {
  price: number
  avgPrice: number
  minPrice?: number
  maxPrice?: number
  recommendation: string
  cheapHours?: number[]
}, options: NotificationOptions = {}): Promise<void> {
  const channels = options.channels || ['all']
  const sendToAll = channels.includes('all')
  
  const results: Promise<any>[] = []
  
  if (sendToAll || channels.includes('ha')) {
    results.push(sendHANotification(priceOpportunityNotification(
      data.price,
      data.avgPrice,
      data.recommendation
    )))
  }
  
  if (sendToAll || channels.includes('telegram')) {
    results.push(broadcastTelegram(formatPriceAlert({
      currentPrice: data.price,
      avgPrice: data.avgPrice,
      recommendation: data.recommendation,
      nextCheapHour: data.cheapHours?.[0] || 3,
    })))
  }
  
  if (sendToAll || channels.includes('discord')) {
    results.push(sendDiscordWebhook({
      embeds: [priceAlertEmbed({
        price: data.price,
        avgPrice: data.avgPrice,
        minPrice: data.minPrice || data.price * 0.5,
        maxPrice: data.maxPrice || data.price * 2,
        cheapHours: data.cheapHours || [],
      })],
    }))
  }
  
  await Promise.allSettled(results)
}

/**
 * Send critical alert with optional escalation
 */
export async function notifyCriticalAlert(
  type: string,
  message: string,
  options: NotificationOptions = {}
): Promise<void> {
  const severity: EscalationLevel = options.priority === 'critical' 
    ? 'emergency' 
    : options.priority === 'high' 
      ? 'critical' 
      : 'warning'
  
  if (options.escalate !== false) {
    // Use escalation system for critical alerts
    await createEscalatingAlert({
      type,
      severity,
      title: type,
      message,
    })
  } else {
    // Direct notification without escalation
    const channels = options.channels || ['all']
    const sendToAll = channels.includes('all')
    
    const results: Promise<any>[] = []
    
    if (sendToAll || channels.includes('ha')) {
      results.push(sendHANotification({
        title: `⚠️ ${type}`,
        message,
        data: { priority: severity, persistent: true },
      }))
    }
    
    if (sendToAll || channels.includes('telegram')) {
      results.push(broadcastTelegram(`⚠️ *${type}*\n\n${message}`))
    }
    
    if (sendToAll || channels.includes('discord')) {
      results.push(sendDiscordWebhook({
        content: `⚠️ **${type}**: ${message}`,
      }))
    }
    
    await Promise.allSettled(results)
  }
}

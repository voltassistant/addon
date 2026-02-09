/**
 * Telegram Bot Integration
 * Send notifications and receive commands via Telegram
 */

import { getConfig } from '../config'
import { checkAlerts, getActiveAlerts, acknowledgeAlert } from '../alerts'

export interface TelegramConfig {
  botToken: string
  chatIds: string[] // Allowed chat IDs
  adminChatId?: string // For critical alerts
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
}

export interface TelegramMessage {
  chatId: string
  text: string
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  replyMarkup?: TelegramReplyMarkup
  disableNotification?: boolean
  photo?: string
  caption?: string
}

export interface TelegramReplyMarkup {
  inline_keyboard?: TelegramInlineButton[][]
  keyboard?: TelegramKeyboardButton[][]
  resize_keyboard?: boolean
  one_time_keyboard?: boolean
}

export interface TelegramInlineButton {
  text: string
  callback_data?: string
  url?: string
}

export interface TelegramKeyboardButton {
  text: string
  request_contact?: boolean
  request_location?: boolean
}

let telegramConfig: TelegramConfig | null = null

export function configureTelegram(config: TelegramConfig): void {
  telegramConfig = config
  console.log('Telegram bot configured')
}

/**
 * Send message via Telegram
 */
export async function sendTelegramMessage(message: TelegramMessage): Promise<boolean> {
  if (!telegramConfig) {
    console.error('Telegram not configured')
    return false
  }
  
  const { botToken } = telegramConfig
  const parseMode = message.parseMode || telegramConfig.parseMode || 'HTML'
  
  try {
    const endpoint = message.photo 
      ? `https://api.telegram.org/bot${botToken}/sendPhoto`
      : `https://api.telegram.org/bot${botToken}/sendMessage`
    
    const body: any = {
      chat_id: message.chatId,
      parse_mode: parseMode,
      disable_notification: message.disableNotification,
    }
    
    if (message.photo) {
      body.photo = message.photo
      body.caption = message.caption || message.text
    } else {
      body.text = message.text
    }
    
    if (message.replyMarkup) {
      body.reply_markup = JSON.stringify(message.replyMarkup)
    }
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.description || 'Telegram API error')
    }
    
    return true
  } catch (error) {
    console.error('Failed to send Telegram message:', error)
    return false
  }
}

/**
 * Broadcast message to all configured chats
 */
export async function broadcastTelegram(
  text: string, 
  options: Partial<TelegramMessage> = {}
): Promise<number> {
  if (!telegramConfig) return 0
  
  let sent = 0
  for (const chatId of telegramConfig.chatIds) {
    const success = await sendTelegramMessage({
      chatId,
      text,
      ...options,
    })
    if (success) sent++
  }
  return sent
}

/**
 * Send to admin only
 */
export async function sendToAdmin(
  text: string,
  options: Partial<TelegramMessage> = {}
): Promise<boolean> {
  if (!telegramConfig?.adminChatId) return false
  
  return sendTelegramMessage({
    chatId: telegramConfig.adminChatId,
    text,
    ...options,
  })
}

// ============== Message Templates ==============

export function formatBatteryStatus(data: {
  soc: number
  power: number
  temp: number
  mode: string
}): string {
  const icon = data.soc > 80 ? '🔋' : data.soc > 30 ? '🔋' : '🪫'
  const powerIcon = data.power > 0 ? '⚡' : '🔌'
  
  return `
${icon} <b>Estado de Batería</b>

🔢 SOC: <b>${data.soc}%</b>
${powerIcon} Potencia: <b>${data.power > 0 ? '+' : ''}${data.power} W</b>
🌡️ Temperatura: <b>${data.temp}°C</b>
⚙️ Modo: <b>${data.mode}</b>
`.trim()
}

export function formatPriceAlert(data: {
  currentPrice: number
  avgPrice: number
  recommendation: string
  nextCheapHour: number
}): string {
  const priceEmoji = data.currentPrice < data.avgPrice ? '💚' : '🔴'
  
  return `
${priceEmoji} <b>Alerta de Precio</b>

💶 Precio actual: <b>${(data.currentPrice * 100).toFixed(1)} ¢/kWh</b>
📊 Media hoy: <b>${(data.avgPrice * 100).toFixed(1)} ¢/kWh</b>
⏰ Próxima hora barata: <b>${data.nextCheapHour}:00</b>

💡 ${data.recommendation}
`.trim()
}

export function formatDailySummary(data: {
  date: string
  solarKwh: number
  consumedKwh: number
  gridImportKwh: number
  gridExportKwh: number
  savedEuros: number
  selfSufficiency: number
}): string {
  const ssEmoji = data.selfSufficiency >= 80 ? '🌟' : data.selfSufficiency >= 50 ? '✅' : '📈'
  
  return `
📊 <b>Resumen ${data.date}</b>

☀️ Producción solar: <b>${data.solarKwh.toFixed(1)} kWh</b>
🏠 Consumo total: <b>${data.consumedKwh.toFixed(1)} kWh</b>
⬇️ Importado red: <b>${data.gridImportKwh.toFixed(1)} kWh</b>
⬆️ Exportado red: <b>${data.gridExportKwh.toFixed(1)} kWh</b>

${ssEmoji} Autosuficiencia: <b>${data.selfSufficiency}%</b>
💰 Ahorro estimado: <b>${data.savedEuros.toFixed(2)}€</b>
`.trim()
}

export function formatCriticalAlert(data: {
  type: string
  message: string
  timestamp: string
}): string {
  return `
🚨 <b>ALERTA CRÍTICA</b> 🚨

⚠️ Tipo: <b>${data.type}</b>
📝 ${data.message}
⏰ ${data.timestamp}

<i>Requiere atención inmediata</i>
`.trim()
}

// ============== Command Handlers ==============

type CommandHandler = (chatId: string, args: string[]) => Promise<string>

const commandHandlers: Map<string, CommandHandler> = new Map()

export function registerCommand(command: string, handler: CommandHandler): void {
  commandHandlers.set(command, handler)
}

export async function handleCommand(chatId: string, command: string, args: string[]): Promise<boolean> {
  // Check if chat is authorized
  if (!telegramConfig?.chatIds.includes(chatId) && chatId !== telegramConfig?.adminChatId) {
    await sendTelegramMessage({
      chatId,
      text: '⛔ No autorizado',
    })
    return false
  }
  
  const handler = commandHandlers.get(command)
  if (!handler) {
    await sendTelegramMessage({
      chatId,
      text: `❓ Comando desconocido: ${command}\n\nUsa /help para ver comandos disponibles.`,
    })
    return false
  }
  
  try {
    const response = await handler(chatId, args)
    await sendTelegramMessage({
      chatId,
      text: response,
    })
    return true
  } catch (error) {
    console.error(`Command error ${command}:`, error)
    await sendTelegramMessage({
      chatId,
      text: `❌ Error ejecutando comando: ${error instanceof Error ? error.message : 'Unknown'}`,
    })
    return false
  }
}

// Register default commands
registerCommand('status', async () => {
  // Would fetch real data in production
  return formatBatteryStatus({
    soc: 75,
    power: 1500,
    temp: 32,
    mode: 'Auto',
  })
})

registerCommand('price', async () => {
  return formatPriceAlert({
    currentPrice: 0.12,
    avgPrice: 0.15,
    recommendation: 'Buen momento para cargar dispositivos',
    nextCheapHour: 3,
  })
})

registerCommand('alerts', async () => {
  const alerts = getActiveAlerts()
  if (alerts.length === 0) {
    return '✅ No hay alertas activas'
  }
  
  return '🔔 <b>Alertas Activas</b>\n\n' + alerts.map(a => 
    `• ${a.severity === 'critical' ? '🔴' : '🟡'} ${a.message}`
  ).join('\n')
})

registerCommand('ack', async (chatId, args) => {
  const alertId = args[0]
  if (!alertId) {
    return '❌ Uso: /ack <alert_id>'
  }
  
  const success = acknowledgeAlert(alertId)
  return success 
    ? '✅ Alerta reconocida' 
    : '❌ Alerta no encontrada'
})

registerCommand('help', async () => {
  return `
🤖 <b>VoltAssistant Bot</b>

<b>Comandos disponibles:</b>

/status - Estado actual de la batería
/price - Precio eléctrico actual
/alerts - Ver alertas activas
/ack &lt;id&gt; - Reconocer alerta
/summary - Resumen del día
/mode &lt;auto|eco|max&gt; - Cambiar modo
/help - Este mensaje

<i>Recibirás notificaciones automáticas de alertas y oportunidades de ahorro.</i>
`.trim()
})

registerCommand('summary', async () => {
  return formatDailySummary({
    date: new Date().toLocaleDateString('es-ES'),
    solarKwh: 25.4,
    consumedKwh: 18.2,
    gridImportKwh: 3.5,
    gridExportKwh: 10.7,
    savedEuros: 4.85,
    selfSufficiency: 81,
  })
})

registerCommand('mode', async (chatId, args) => {
  const mode = args[0]?.toLowerCase()
  const validModes = ['auto', 'eco', 'max']
  
  if (!mode || !validModes.includes(mode)) {
    return `❌ Uso: /mode <${validModes.join('|')}>`
  }
  
  // Would call actual mode change in production
  return `✅ Modo cambiado a: <b>${mode.toUpperCase()}</b>`
})

// ============== Webhook Handler for Updates ==============

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from: { id: number; first_name: string }
    chat: { id: number; type: string }
    text?: string
  }
  callback_query?: {
    id: string
    from: { id: number }
    message: { chat: { id: number } }
    data: string
  }
}

export async function handleWebhookUpdate(update: TelegramUpdate): Promise<void> {
  // Handle text commands
  if (update.message?.text?.startsWith('/')) {
    const parts = update.message.text.slice(1).split(' ')
    const command = parts[0].split('@')[0] // Remove bot username if present
    const args = parts.slice(1)
    
    await handleCommand(update.message.chat.id.toString(), command, args)
    return
  }
  
  // Handle callback queries (button presses)
  if (update.callback_query) {
    const { id, data } = update.callback_query
    const chatId = update.callback_query.message.chat.id.toString()
    
    // Answer callback to remove loading state
    if (telegramConfig) {
      await fetch(`https://api.telegram.org/bot${telegramConfig.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: id }),
      })
    }
    
    // Process callback data as command
    const [command, ...args] = data.split(':')
    await handleCommand(chatId, command, args)
  }
}

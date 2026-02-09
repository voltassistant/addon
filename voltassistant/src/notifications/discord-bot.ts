/**
 * Discord Bot Integration
 * Send rich notifications and handle commands via Discord
 */

import { getConfig } from '../config'
import { getActiveAlerts, acknowledgeAlert } from '../alerts'

export interface DiscordConfig {
  webhookUrl?: string // For simple notifications
  botToken?: string // For full bot features
  channelId?: string // Default channel
  guildId?: string // Server ID
  adminRoleId?: string // Role for admin commands
}

export interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color?: number
  timestamp?: string
  footer?: { text: string; icon_url?: string }
  thumbnail?: { url: string }
  image?: { url: string }
  author?: { name: string; url?: string; icon_url?: string }
  fields?: Array<{ name: string; value: string; inline?: boolean }>
}

export interface DiscordMessage {
  content?: string
  username?: string
  avatar_url?: string
  embeds?: DiscordEmbed[]
  components?: DiscordComponent[]
  tts?: boolean
}

export interface DiscordComponent {
  type: 1 // Action Row
  components: DiscordButton[]
}

export interface DiscordButton {
  type: 2 // Button
  style: 1 | 2 | 3 | 4 | 5 // Primary, Secondary, Success, Danger, Link
  label: string
  custom_id?: string
  url?: string
  emoji?: { name: string; id?: string }
  disabled?: boolean
}

let discordConfig: DiscordConfig | null = null

// Color palette
const COLORS = {
  success: 0x22C55E,
  warning: 0xF59E0B,
  error: 0xEF4444,
  info: 0x3B82F6,
  solar: 0xFBBF24,
  battery: 0x10B981,
}

export function configureDiscord(config: DiscordConfig): void {
  discordConfig = config
  console.log('Discord configured')
}

/**
 * Send message via webhook
 */
export async function sendDiscordWebhook(message: DiscordMessage): Promise<boolean> {
  if (!discordConfig?.webhookUrl) {
    console.error('Discord webhook not configured')
    return false
  }
  
  try {
    const response = await fetch(discordConfig.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...message,
        username: message.username || 'VoltAssistant',
        avatar_url: message.avatar_url || 'https://example.com/voltassistant-icon.png',
      }),
    })
    
    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status}`)
    }
    
    return true
  } catch (error) {
    console.error('Failed to send Discord message:', error)
    return false
  }
}

/**
 * Send via Bot API (more features)
 */
export async function sendDiscordMessage(
  channelId: string, 
  message: DiscordMessage
): Promise<boolean> {
  if (!discordConfig?.botToken) {
    console.error('Discord bot not configured')
    return false
  }
  
  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${discordConfig.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      }
    )
    
    if (!response.ok) {
      const errorData = await response.json() as { message?: string }
      throw new Error(errorData.message || 'Discord API error')
    }
    
    return true
  } catch (error) {
    console.error('Failed to send Discord message:', error)
    return false
  }
}

// ============== Embed Templates ==============

export function batteryStatusEmbed(data: {
  soc: number
  power: number
  temp: number
  mode: string
  trend: 'charging' | 'discharging' | 'idle'
}): DiscordEmbed {
  const trendEmoji = {
    charging: '⚡ Cargando',
    discharging: '🔋 Descargando',
    idle: '⏸️ En espera',
  }
  
  return {
    title: '🔋 Estado de Batería',
    color: data.soc > 50 ? COLORS.success : data.soc > 20 ? COLORS.warning : COLORS.error,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'SOC', value: `${data.soc}%`, inline: true },
      { name: 'Potencia', value: `${data.power} W`, inline: true },
      { name: 'Temperatura', value: `${data.temp}°C`, inline: true },
      { name: 'Modo', value: data.mode, inline: true },
      { name: 'Estado', value: trendEmoji[data.trend], inline: true },
    ],
    footer: { text: 'VoltAssistant' },
  }
}

export function priceAlertEmbed(data: {
  price: number
  avgPrice: number
  minPrice: number
  maxPrice: number
  cheapHours: number[]
}): DiscordEmbed {
  const priceStatus = data.price < data.avgPrice ? 'bajo' : 'alto'
  const color = data.price < data.avgPrice ? COLORS.success : COLORS.warning
  
  return {
    title: `💶 Precio Eléctrico ${priceStatus === 'bajo' ? 'Bajo' : 'Alto'}`,
    description: `El precio actual está **${priceStatus}** respecto a la media del día`,
    color,
    timestamp: new Date().toISOString(),
    fields: [
      { name: 'Precio Actual', value: `${(data.price * 100).toFixed(2)} ¢/kWh`, inline: true },
      { name: 'Media Hoy', value: `${(data.avgPrice * 100).toFixed(2)} ¢/kWh`, inline: true },
      { name: 'Rango', value: `${(data.minPrice * 100).toFixed(1)} - ${(data.maxPrice * 100).toFixed(1)} ¢`, inline: true },
      { 
        name: 'Horas Baratas', 
        value: data.cheapHours.map(h => `${h}:00`).join(', ') || 'N/A',
        inline: false 
      },
    ],
    footer: { text: 'Datos PVPC • VoltAssistant' },
  }
}

export function criticalAlertEmbed(data: {
  type: string
  severity: 'warning' | 'critical'
  message: string
  recommendation?: string
}): DiscordEmbed {
  return {
    title: `${data.severity === 'critical' ? '🚨' : '⚠️'} ${data.type}`,
    description: data.message,
    color: data.severity === 'critical' ? COLORS.error : COLORS.warning,
    timestamp: new Date().toISOString(),
    fields: data.recommendation ? [
      { name: '💡 Recomendación', value: data.recommendation, inline: false }
    ] : undefined,
    footer: { text: `Alerta ${data.severity} • VoltAssistant` },
  }
}

export function dailySummaryEmbed(data: {
  date: string
  solarKwh: number
  consumedKwh: number
  gridImportKwh: number
  gridExportKwh: number
  savedEuros: number
  selfSufficiency: number
  co2Saved: number
}): DiscordEmbed {
  const grade = data.selfSufficiency >= 90 ? 'A+' 
    : data.selfSufficiency >= 80 ? 'A' 
    : data.selfSufficiency >= 70 ? 'B'
    : data.selfSufficiency >= 50 ? 'C'
    : 'D'
  
  return {
    title: `📊 Resumen del Día - ${data.date}`,
    color: COLORS.solar,
    timestamp: new Date().toISOString(),
    thumbnail: { url: 'https://example.com/solar-icon.png' },
    fields: [
      { name: '☀️ Producción Solar', value: `${data.solarKwh.toFixed(1)} kWh`, inline: true },
      { name: '🏠 Consumo Total', value: `${data.consumedKwh.toFixed(1)} kWh`, inline: true },
      { name: '⬇️ Importado', value: `${data.gridImportKwh.toFixed(1)} kWh`, inline: true },
      { name: '⬆️ Exportado', value: `${data.gridExportKwh.toFixed(1)} kWh`, inline: true },
      { name: '💰 Ahorro', value: `${data.savedEuros.toFixed(2)}€`, inline: true },
      { name: '🌱 CO₂ Evitado', value: `${data.co2Saved.toFixed(1)} kg`, inline: true },
      { name: '📈 Autosuficiencia', value: `${data.selfSufficiency}% (${grade})`, inline: false },
    ],
    footer: { text: 'VoltAssistant Energy Monitor' },
  }
}

// ============== Interactive Components ==============

export function batteryControlButtons(): DiscordComponent {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: 'Cargar',
        custom_id: 'battery_charge',
        emoji: { name: '⚡' },
      },
      {
        type: 2,
        style: 2,
        label: 'Estado',
        custom_id: 'battery_status',
        emoji: { name: '📊' },
      },
      {
        type: 2,
        style: 3,
        label: 'Modo Eco',
        custom_id: 'mode_eco',
        emoji: { name: '🌱' },
      },
      {
        type: 2,
        style: 4,
        label: 'Detener',
        custom_id: 'battery_stop',
        emoji: { name: '⏹️' },
      },
    ],
  }
}

export function alertAckButtons(alertId: string): DiscordComponent {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: 'Reconocer',
        custom_id: `ack_${alertId}`,
        emoji: { name: '✅' },
      },
      {
        type: 2,
        style: 2,
        label: 'Ver Detalles',
        custom_id: `details_${alertId}`,
        emoji: { name: '🔍' },
      },
      {
        type: 2,
        style: 5,
        label: 'Dashboard',
        url: 'http://homeassistant.local:8123/lovelace/energy',
        emoji: { name: '🏠' },
      },
    ],
  }
}

// ============== Command Handlers ==============

type CommandHandler = (args: string[], userId: string) => Promise<DiscordMessage>

const commandHandlers: Map<string, CommandHandler> = new Map()

export function registerCommand(command: string, handler: CommandHandler): void {
  commandHandlers.set(command, handler)
}

export async function handleCommand(
  command: string, 
  args: string[], 
  userId: string
): Promise<DiscordMessage | null> {
  const handler = commandHandlers.get(command)
  if (!handler) return null
  
  try {
    return await handler(args, userId)
  } catch (error) {
    console.error(`Command error ${command}:`, error)
    return {
      content: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}

// Register default commands
registerCommand('status', async () => ({
  embeds: [batteryStatusEmbed({
    soc: 75,
    power: 1200,
    temp: 28,
    mode: 'Auto',
    trend: 'charging',
  })],
  components: [batteryControlButtons()],
}))

registerCommand('price', async () => ({
  embeds: [priceAlertEmbed({
    price: 0.12,
    avgPrice: 0.15,
    minPrice: 0.08,
    maxPrice: 0.25,
    cheapHours: [3, 4, 5, 14, 15],
  })],
}))

registerCommand('alerts', async () => {
  const alerts = getActiveAlerts()
  
  if (alerts.length === 0) {
    return { content: '✅ No hay alertas activas' }
  }
  
  return {
    embeds: alerts.slice(0, 5).map(alert => criticalAlertEmbed({
      type: alert.type,
      severity: alert.severity as 'warning' | 'critical',
      message: alert.message,
    })),
  }
})

registerCommand('summary', async () => ({
  embeds: [dailySummaryEmbed({
    date: new Date().toLocaleDateString('es-ES'),
    solarKwh: 28.5,
    consumedKwh: 22.3,
    gridImportKwh: 4.2,
    gridExportKwh: 10.4,
    savedEuros: 5.67,
    selfSufficiency: 81,
    co2Saved: 12.3,
  })],
}))

registerCommand('help', async () => ({
  embeds: [{
    title: '🤖 VoltAssistant Bot',
    description: 'Comandos disponibles para monitorizar tu sistema solar',
    color: COLORS.info,
    fields: [
      { name: '/status', value: 'Estado actual de batería e inversor', inline: true },
      { name: '/price', value: 'Precio eléctrico actual', inline: true },
      { name: '/alerts', value: 'Ver alertas activas', inline: true },
      { name: '/summary', value: 'Resumen del día', inline: true },
      { name: '/mode <modo>', value: 'Cambiar modo (auto/eco/max)', inline: true },
      { name: '/help', value: 'Este mensaje', inline: true },
    ],
    footer: { text: 'VoltAssistant v1.0' },
  }],
}))

// ============== Interaction Handler ==============

export interface DiscordInteraction {
  type: number
  data?: {
    name?: string
    custom_id?: string
    options?: Array<{ name: string; value: any }>
  }
  member?: { user: { id: string } }
  user?: { id: string }
}

export async function handleInteraction(
  interaction: DiscordInteraction
): Promise<DiscordMessage | null> {
  const userId = interaction.member?.user.id || interaction.user?.id || ''
  
  // Slash command
  if (interaction.type === 2 && interaction.data?.name) {
    const args = interaction.data.options?.map(o => String(o.value)) || []
    return handleCommand(interaction.data.name, args, userId)
  }
  
  // Button click
  if (interaction.type === 3 && interaction.data?.custom_id) {
    const customId = interaction.data.custom_id
    
    // Acknowledge alert
    if (customId.startsWith('ack_')) {
      const alertId = customId.slice(4)
      const success = acknowledgeAlert(alertId)
      return {
        content: success ? '✅ Alerta reconocida' : '❌ Alerta no encontrada',
      }
    }
    
    // Battery controls
    if (customId === 'battery_status') {
      return handleCommand('status', [], userId)
    }
    
    if (customId === 'battery_charge') {
      return { content: '⚡ Iniciando carga desde red...' }
    }
    
    if (customId === 'mode_eco') {
      return { content: '🌱 Modo eco activado' }
    }
  }
  
  return null
}

/**
 * VoltAssistant HTTP Server
 * Provides REST API and webhook endpoints for integration with Home Assistant,
 * cron jobs, and other automation systems.
 */

import http from 'http'
import fs from 'fs'
import path from 'path'
import { getPVPCPrices, formatPrice } from './pvpc'
import { getSolarForecast } from './solar'
import { generateChargingPlan, formatPlan, BatteryConfig } from './optimizer'
import { getInverterStatus } from './realtime'
import { applyChargingAction, checkConnection } from './ha-integration'
import { getDayHistory, getWeekHistory, findBestChargingWindows } from './history'
import { 
  getConfig, setConfig, resetConfig, 
  getActiveAlerts, getAlertHistory, 
  acknowledgeAlert, clearAlert, checkAlerts 
} from './alerts'
import {
  getLoadManagerConfig, setLoadManagerConfig,
  getLoadManagerState, updateState as updateLoadState,
  balanceLoads, addLoad, removeLoad, updateLoad,
  forceRestoreAll, setEnabled as setLoadManagerEnabled,
} from './load-manager'
import dotenv from 'dotenv'

dotenv.config()

const PORT = parseInt(process.env.PORT || '3001', 10)
const API_KEY = process.env.API_KEY || ''

interface RequestBody {
  date?: string
  battery?: number
  consumptionPattern?: number[]
  detailed?: boolean
  action?: string
  id?: string
  // Alert config fields (passed through to setConfig)
  [key: string]: unknown
}

// Default battery config
const DEFAULT_BATTERY: BatteryConfig = {
  capacityWh: 10000,
  maxChargeRateW: 3000,
  minSoC: 0.1,
  maxSoC: 1.0,
  currentSoC: 0.5,
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
}

// Parse JSON body
async function parseBody(req: http.IncomingMessage): Promise<RequestBody> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// Check API key if configured
function checkAuth(req: http.IncomingMessage): boolean {
  if (!API_KEY) return true
  const key = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '')
  return key === API_KEY
}

// Send JSON response
function sendJSON(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders })
  res.end(JSON.stringify(data, null, 2))
}

// Request counters for metrics
let requestCounts = {
  status: 0,
  dashboard: 0,
  plan: 0,
  prices: 0,
  solar: 0,
  history: 0,
  control: 0,
}

// Routes
const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>> = {
  
  // Prometheus metrics
  'GET /metrics': async (req, res) => {
    const lines = [
      '# HELP voltassistant_up Service status (1 = up)',
      '# TYPE voltassistant_up gauge',
      'voltassistant_up 1',
      '',
      '# HELP voltassistant_requests_total Request counts by endpoint',
      '# TYPE voltassistant_requests_total counter',
      ...Object.entries(requestCounts).map(([k, v]) => 
        `voltassistant_requests_total{endpoint="${k}"} ${v}`
      ),
      '',
      '# HELP nodejs_process_uptime_seconds Process uptime',
      '# TYPE nodejs_process_uptime_seconds gauge',
      `nodejs_process_uptime_seconds ${Math.floor(process.uptime())}`,
      '',
      '# HELP nodejs_heap_bytes Node.js heap usage',
      '# TYPE nodejs_heap_bytes gauge',
      `nodejs_heap_bytes{type="used"} ${process.memoryUsage().heapUsed}`,
      `nodejs_heap_bytes{type="total"} ${process.memoryUsage().heapTotal}`,
    ]
    
    res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders })
    res.end(lines.join('\n'))
  },

  // Health check
  'GET /health': async (req, res) => {
    sendJSON(res, 200, { status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() })
  },

  // Get today's plan
  'GET /plan': async (req, res) => {
    try {
      const date = new Date()
      const pvpc = await getPVPCPrices(date)
      const solar = await getSolarForecast(date)
      const plan = generateChargingPlan(pvpc, solar, DEFAULT_BATTERY)
      
      sendJSON(res, 200, {
        success: true,
        plan: {
          date: plan.date,
          recommendations: plan.recommendations,
          gridChargeHours: plan.gridChargeHours,
          gridChargeCost: plan.gridChargeCost,
          solarChargeWh: plan.solarChargeWh,
          gridExportWh: plan.gridExportWh,
          savings: plan.savings,
        }
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get detailed plan with hourly breakdown
  'POST /plan': async (req, res) => {
    try {
      const body = await parseBody(req)
      const date = body.date ? new Date(body.date) : new Date()
      
      const battery: BatteryConfig = body.battery ? {
        ...DEFAULT_BATTERY,
        capacityWh: body.battery * 1000,
      } : DEFAULT_BATTERY
      
      const pvpc = await getPVPCPrices(date)
      const solar = await getSolarForecast(date)
      const plan = generateChargingPlan(pvpc, solar, battery, body.consumptionPattern)
      
      const response: any = {
        success: true,
        plan: {
          date: plan.date,
          recommendations: plan.recommendations,
          gridChargeHours: plan.gridChargeHours,
          gridChargeCost: Math.round(plan.gridChargeCost * 100) / 100,
          solarChargeWh: plan.solarChargeWh,
          gridExportWh: plan.gridExportWh,
          savings: Math.round(plan.savings * 100) / 100,
        }
      }
      
      if (body.detailed) {
        response.plan.hourlyPlan = plan.hourlyPlan.map(h => ({
          hour: h.hour,
          price: Math.round(h.price * 10000) / 10000,
          solarWatts: h.solarWatts,
          action: h.decision.action,
          expectedSoC: h.expectedSoC,
        }))
      }
      
      sendJSON(res, 200, response)
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get PVPC prices
  'GET /prices': async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`)
      const dateParam = url.searchParams.get('date')
      const date = dateParam ? new Date(dateParam) : new Date()
      
      const pvpc = await getPVPCPrices(date)
      
      sendJSON(res, 200, {
        success: true,
        date: pvpc.date,
        averagePrice: Math.round(pvpc.averagePrice * 10000) / 10000,
        cheapestHours: pvpc.cheapestHours,
        expensiveHours: pvpc.expensiveHours,
        prices: pvpc.prices.map(p => ({
          hour: p.hour,
          price: Math.round(p.price * 10000) / 10000,
          priceFormatted: formatPrice(p.price),
        }))
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get solar forecast
  'GET /solar': async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`)
      const dateParam = url.searchParams.get('date')
      const date = dateParam ? new Date(dateParam) : new Date()
      
      const solar = await getSolarForecast(date)
      
      sendJSON(res, 200, {
        success: true,
        date: solar.date,
        totalKwh: Math.round(solar.totalWh / 100) / 10,
        peakHour: solar.peakHour,
        peakWatts: solar.peakWatts,
        forecasts: solar.forecasts.map(f => ({
          hour: f.hour,
          watts: f.watts,
        }))
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Webhook for Home Assistant automation
  'POST /webhook/ha': async (req, res) => {
    try {
      const body = await parseBody(req)
      const date = new Date()
      
      const pvpc = await getPVPCPrices(date)
      const solar = await getSolarForecast(date)
      const plan = generateChargingPlan(pvpc, solar, DEFAULT_BATTERY)
      
      const currentHour = date.getHours()
      const currentAction = plan.hourlyPlan[currentHour]?.decision.action || 'idle'
      const nextChargeHour = plan.gridChargeHours.find(h => h > currentHour) || null
      
      // Return HA-friendly format
      sendJSON(res, 200, {
        current_action: currentAction,
        should_charge_from_grid: currentAction === 'charge_from_grid',
        should_discharge: currentAction === 'discharge',
        grid_charge_hours: plan.gridChargeHours,
        next_charge_hour: nextChargeHour,
        current_price: pvpc.prices[currentHour]?.price || 0,
        is_cheap_hour: pvpc.cheapestHours.includes(currentHour),
        is_expensive_hour: pvpc.expensiveHours.includes(currentHour),
        expected_solar_watts: solar.forecasts[currentHour]?.watts || 0,
        recommendations: plan.recommendations,
        estimated_savings: plan.savings,
      })
    } catch (error) {
      sendJSON(res, 500, { error: (error as Error).message })
    }
  },

  // Control inverter charging mode
  'POST /control': async (req, res) => {
    try {
      const body = await parseBody(req)
      const { action } = body
      
      if (!action || !['charge', 'discharge', 'auto', 'idle'].includes(action)) {
        sendJSON(res, 400, { 
          error: 'Invalid action. Use: charge, discharge, auto, or idle' 
        })
        return
      }
      
      // Check HA connection first
      const connected = await checkConnection()
      if (!connected) {
        sendJSON(res, 503, { 
          error: 'Home Assistant not connected',
          hint: 'Check HA_URL and HA_TOKEN in environment'
        })
        return
      }
      
      // Map action to charging action
      const actionMap: Record<string, 'charge_from_grid' | 'discharge' | 'idle'> = {
        'charge': 'charge_from_grid',
        'discharge': 'discharge',
        'auto': 'idle',
        'idle': 'idle',
      }
      
      const result = await applyChargingAction(actionMap[action])
      
      sendJSON(res, 200, {
        success: result,
        action,
        message: result 
          ? `Successfully set mode to: ${action}` 
          : 'Failed to apply action',
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Webhook for notifications (can be called by cron)
  'POST /webhook/notify': async (req, res) => {
    try {
      const date = new Date()
      const pvpc = await getPVPCPrices(date)
      const solar = await getSolarForecast(date)
      const plan = generateChargingPlan(pvpc, solar, DEFAULT_BATTERY)
      
      // Generate notification text
      const lines = [
        `⚡ VoltAssistant - ${date.toLocaleDateString('es-ES')}`,
        '',
        `💶 Precio medio: ${formatPrice(pvpc.averagePrice)}`,
        `☀️ Solar esperado: ${Math.round(solar.totalWh / 1000)}kWh`,
        `💰 Ahorro estimado: €${plan.savings.toFixed(2)}`,
        '',
        ...plan.recommendations,
      ]
      
      const message = lines.join('\n')
      
      sendJSON(res, 200, {
        success: true,
        message,
        summary: {
          avgPrice: pvpc.averagePrice,
          solarKwh: Math.round(solar.totalWh / 1000),
          savings: plan.savings,
          chargeHours: plan.gridChargeHours,
        }
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get real-time inverter status from Home Assistant
  'GET /status': async (req, res) => {
    try {
      const status = await getInverterStatus()
      sendJSON(res, 200, { success: true, ...status })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get combined status + plan
  'GET /dashboard': async (req, res) => {
    try {
      const [status, pvpc, solar] = await Promise.all([
        getInverterStatus(),
        getPVPCPrices(new Date()),
        getSolarForecast(new Date()),
      ])
      
      const plan = generateChargingPlan(pvpc, solar, {
        capacityWh: status.battery.capacity * 1000,
        maxChargeRateW: 3000,
        minSoC: 0.1,
        maxSoC: 1.0,
        currentSoC: status.battery.soc / 100,
      })
      
      const currentHour = new Date().getHours()
      const currentAction = plan.hourlyPlan[currentHour]?.decision.action || 'idle'
      
      sendJSON(res, 200, {
        success: true,
        timestamp: new Date().toISOString(),
        realtime: status,
        plan: {
          currentAction,
          recommendations: plan.recommendations,
          gridChargeHours: plan.gridChargeHours,
          estimatedSavings: plan.savings,
        },
        prices: {
          current: pvpc.prices[currentHour]?.price || 0,
          average: pvpc.averagePrice,
          cheapestHours: pvpc.cheapestHours,
          expensiveHours: pvpc.expensiveHours,
        },
        solar: {
          forecast: solar.totalWh,
          peak: { hour: solar.peakHour, watts: solar.peakWatts },
        },
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get price/solar history for past N days
  'GET /history': async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`)
      const daysParam = url.searchParams.get('days')
      const days = daysParam ? parseInt(daysParam, 10) : 7
      
      const history = await getDayHistory(Math.min(days, 14))
      
      sendJSON(res, 200, {
        success: true,
        days: history,
        count: history.length,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get weekly summary with analysis
  'GET /history/week': async (req, res) => {
    try {
      const week = await getWeekHistory()
      const bestWindows = findBestChargingWindows(week.days)
      
      sendJSON(res, 200, {
        success: true,
        ...week,
        bestChargingWindows: bestWindows,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get text summary (for chat integrations)
  'GET /summary': async (req, res) => {
    try {
      const date = new Date()
      const pvpc = await getPVPCPrices(date)
      const solar = await getSolarForecast(date)
      const plan = generateChargingPlan(pvpc, solar, DEFAULT_BATTERY)
      
      res.writeHead(200, { 'Content-Type': 'text/plain', ...corsHeaders })
      res.end(formatPlan(plan))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...corsHeaders })
      res.end(`Error: ${(error as Error).message}`)
    }
  },

  // Get alert configuration
  'GET /alerts/config': async (req, res) => {
    sendJSON(res, 200, { success: true, config: getConfig() })
  },

  // Update alert configuration
  'POST /alerts/config': async (req, res) => {
    try {
      const body = await parseBody(req)
      const config = setConfig(body as any)
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Reset alert configuration to defaults
  'POST /alerts/reset': async (req, res) => {
    sendJSON(res, 200, { success: true, config: resetConfig() })
  },

  // Get active alerts
  'GET /alerts': async (req, res) => {
    const alerts = getActiveAlerts()
    sendJSON(res, 200, { 
      success: true, 
      count: alerts.length,
      alerts 
    })
  },

  // Check for new alerts based on current state
  'POST /alerts/check': async (req, res) => {
    try {
      const status = await getInverterStatus()
      const pvpc = await getPVPCPrices(new Date())
      const hour = new Date().getHours()
      
      const newAlerts = checkAlerts({
        batterySoc: status.battery.soc,
        inverterTemp: status.temperature.inverter,
        currentPrice: pvpc.prices[hour]?.price || 0,
        dailySolarKwh: status.solar.todayKwh,
      })
      
      sendJSON(res, 200, {
        success: true,
        newAlerts: newAlerts.length,
        alerts: newAlerts,
        activeAlerts: getActiveAlerts(),
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Acknowledge an alert
  'POST /alerts/ack': async (req, res) => {
    try {
      const body = await parseBody(req)
      if (!body.id) {
        sendJSON(res, 400, { error: 'Alert ID required' })
        return
      }
      const result = acknowledgeAlert(body.id as string)
      sendJSON(res, 200, { success: result })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Clear an alert
  'POST /alerts/clear': async (req, res) => {
    try {
      const body = await parseBody(req)
      if (!body.id) {
        sendJSON(res, 400, { error: 'Alert ID required' })
        return
      }
      const result = clearAlert(body.id as string)
      sendJSON(res, 200, { success: result })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get alert history
  'GET /alerts/history': async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)
    sendJSON(res, 200, { 
      success: true, 
      history: getAlertHistory(limit)
    })
  },

  // Daily report for notifications
  'GET /report/daily': async (req, res) => {
    try {
      const [status, pvpc, solar] = await Promise.all([
        getInverterStatus(),
        getPVPCPrices(new Date()),
        getSolarForecast(new Date()),
      ])
      
      const plan = generateChargingPlan(pvpc, solar, {
        capacityWh: status.battery.capacity * 1000 || 10000,
        maxChargeRateW: 3000,
        minSoC: 0.1,
        maxSoC: 1.0,
        currentSoC: (status.battery.soc || 50) / 100,
      })
      
      const now = new Date()
      const hour = now.getHours()
      const greeting = hour < 12 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches'
      
      const lines = [
        `☀️ ${greeting}! Resumen energético:`,
        '',
        `🔋 Batería: ${status.battery.soc}% (${status.battery.state})`,
        `☀️ Solar hoy: ${status.solar.todayKwh} kWh producidos`,
        `   Previsión: ${Math.round(solar.totalWh / 1000)} kWh`,
        '',
        `💶 Precio actual: ${(pvpc.prices[hour]?.price * 100 || 0).toFixed(2)}¢/kWh`,
        `   Media hoy: ${(pvpc.averagePrice * 100).toFixed(2)}¢/kWh`,
        '',
        `⏰ Horas baratas: ${pvpc.cheapestHours.map(h => `${h}:00`).join(', ')}`,
        `⚠️ Horas caras: ${pvpc.expensiveHours.map(h => `${h}:00`).join(', ')}`,
        '',
        `💰 Ahorro estimado hoy: €${plan.savings.toFixed(2)}`,
      ]
      
      // Add alerts if any
      if (status.battery.soc < 20) {
        lines.push('', '⚠️ ALERTA: Batería baja, considera cargar desde red')
      }
      if (status.health.issues.length > 0) {
        lines.push('', '⚠️ Alertas: ' + status.health.issues.join(', '))
      }
      
      sendJSON(res, 200, {
        success: true,
        report: lines.join('\n'),
        data: {
          battery: status.battery,
          solar: {
            today: status.solar.todayKwh,
            forecast: Math.round(solar.totalWh / 1000),
          },
          price: {
            current: pvpc.prices[hour]?.price || 0,
            average: pvpc.averagePrice,
          },
          savings: plan.savings,
          alerts: status.health.issues,
        }
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD MANAGER ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Get load manager status
  'GET /loads/status': async (req, res) => {
    try {
      const state = await updateLoadState()
      sendJSON(res, 200, {
        success: true,
        ...state,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get load manager config
  'GET /loads/config': async (req, res) => {
    try {
      const config = getLoadManagerConfig()
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Update load manager config
  'POST /loads/config': async (req, res) => {
    try {
      const body = await parseBody(req)
      const config = setLoadManagerConfig(body as any)
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Add a load
  'POST /loads': async (req, res) => {
    try {
      const body = await parseBody(req)
      if (!body.id || !body.name || !body.entity_id || !body.priority) {
        sendJSON(res, 400, { success: false, error: 'Missing required fields: id, name, entity_id, priority' })
        return
      }
      const load = addLoad(body as any)
      sendJSON(res, 200, { success: true, load })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Update a load
  'PUT /loads': async (req, res) => {
    try {
      const body = await parseBody(req)
      if (!body.id) {
        sendJSON(res, 400, { success: false, error: 'Missing load id' })
        return
      }
      const load = updateLoad(body.id as string, body as any)
      if (!load) {
        sendJSON(res, 404, { success: false, error: 'Load not found' })
        return
      }
      sendJSON(res, 200, { success: true, load })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Delete a load
  'DELETE /loads': async (req, res) => {
    try {
      const body = await parseBody(req)
      if (!body.id) {
        sendJSON(res, 400, { success: false, error: 'Missing load id' })
        return
      }
      const removed = removeLoad(body.id as string)
      sendJSON(res, 200, { success: true, removed })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Run balance check (manual trigger)
  'POST /loads/balance': async (req, res) => {
    try {
      const result = await balanceLoads()
      const state = getLoadManagerState()
      sendJSON(res, 200, {
        success: true,
        ...result,
        state: {
          totalPower: state.totalPower,
          maxAvailable: state.maxAvailable,
          usagePercent: state.usagePercent,
          isOverloaded: state.isOverloaded,
          shedLoads: state.shedLoads,
        },
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Force restore all shed loads
  'POST /loads/restore': async (req, res) => {
    try {
      const restored = await forceRestoreAll()
      sendJSON(res, 200, { success: true, restored })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Enable/disable load manager
  'POST /loads/enable': async (req, res) => {
    try {
      const body = await parseBody(req)
      const enabled = body.enabled === true || body.enabled === 'true'
      setLoadManagerEnabled(enabled)
      sendJSON(res, 200, { success: true, enabled })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Webhook for HA automation to trigger balance
  'POST /webhook/loads': async (req, res) => {
    try {
      const result = await balanceLoads()
      const state = getLoadManagerState()
      
      // Return HA-friendly format
      sendJSON(res, 200, {
        balanced: true,
        actions_taken: result.actions.length,
        actions: result.actions,
        total_power: state.totalPower,
        max_available: state.maxAvailable,
        is_overloaded: state.isOverloaded,
        shed_loads: state.shedLoads,
        last_action: state.lastAction,
      })
    } catch (error) {
      sendJSON(res, 500, { error: (error as Error).message })
    }
  },
}

// Serve static files
function serveStatic(res: http.ServerResponse, filePath: string, contentType: string) {
  try {
    const fullPath = path.join(__dirname, '..', 'public', filePath)
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath)
      res.writeHead(200, { 'Content-Type': contentType, ...corsHeaders })
      res.end(content)
      return true
    }
  } catch (e) {
    // Fall through
  }
  return false
}

// Request handler
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }
  
  // Serve static files
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (serveStatic(res, 'index.html', 'text/html')) return
  }
  if (url.pathname.endsWith('.css')) {
    if (serveStatic(res, url.pathname, 'text/css')) return
  }
  if (url.pathname.endsWith('.js')) {
    if (serveStatic(res, url.pathname, 'application/javascript')) return
  }
  
  // Check auth for API routes
  if (!checkAuth(req)) {
    sendJSON(res, 401, { error: 'Unauthorized' })
    return
  }
  
  // Match route
  const routeKey = `${req.method} ${url.pathname}`
  const handler = routes[routeKey]
  
  if (handler) {
    try {
      await handler(req, res)
    } catch (error) {
      console.error('Handler error:', error)
      sendJSON(res, 500, { error: 'Internal server error' })
    }
  } else {
    sendJSON(res, 404, { error: 'Not found', availableRoutes: Object.keys(routes) })
  }
}

// Start server
export function startServer() {
  const server = http.createServer(handleRequest)
  
  server.listen(PORT, () => {
    console.log(`⚡ VoltAssistant API Server`)
    console.log(`   Listening on http://0.0.0.0:${PORT}`)
    console.log(`   API Key: ${API_KEY ? 'enabled' : 'disabled'}`)
    console.log('')
    console.log('📡 Available endpoints:')
    console.log('   GET  /health       - Health check')
    console.log('   GET  /status       - Real-time inverter status from HA')
    console.log('   GET  /dashboard    - Combined status + plan + prices')
    console.log('   GET  /plan         - Get today\'s charging plan')
    console.log('   POST /plan         - Get plan with custom params')
    console.log('   GET  /prices       - Get PVPC prices')
    console.log('   GET  /solar        - Get solar forecast')
    console.log('   GET  /history      - Price/solar history (last 7 days)')
    console.log('   GET  /history/week - Weekly summary with best windows')
    console.log('   POST /webhook/ha   - Home Assistant webhook')
    console.log('   POST /webhook/notify - Notification webhook')
    console.log('   GET  /summary      - Plain text summary')
    console.log('')
    console.log('🔌 Load Manager:')
    console.log('   GET  /loads/status  - Current load state')
    console.log('   GET  /loads/config  - Get config')
    console.log('   POST /loads/config  - Update config')
    console.log('   POST /loads         - Add a load')
    console.log('   PUT  /loads         - Update a load')
    console.log('   DELETE /loads       - Remove a load')
    console.log('   POST /loads/balance - Run balance check')
    console.log('   POST /loads/restore - Force restore all')
    console.log('   POST /loads/enable  - Enable/disable')
    console.log('   POST /webhook/loads - HA webhook trigger')
  })
  
  return server
}

// Run if called directly
if (require.main === module) {
  startServer()
}

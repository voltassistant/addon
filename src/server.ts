/**
 * VoltAssistant HTTP Server
 * Provides REST API and webhook endpoints for integration with Home Assistant,
 * cron jobs, and other automation systems.
 */

import http from 'http'
import { getPVPCPrices, formatPrice } from './pvpc'
import { getSolarForecast } from './solar'
import { generateChargingPlan, formatPlan, BatteryConfig } from './optimizer'
import { getInverterStatus } from './realtime'
import dotenv from 'dotenv'

dotenv.config()

const PORT = parseInt(process.env.PORT || '3001', 10)
const API_KEY = process.env.API_KEY || ''

interface RequestBody {
  date?: string
  battery?: number
  consumptionPattern?: number[]
  detailed?: boolean
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

// Routes
const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>> = {
  
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
}

// Request handler
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }
  
  // Check auth
  if (!checkAuth(req)) {
    sendJSON(res, 401, { error: 'Unauthorized' })
    return
  }
  
  // Match route
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
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
    console.log('   POST /webhook/ha   - Home Assistant webhook')
    console.log('   POST /webhook/notify - Notification webhook')
    console.log('   GET  /summary      - Plain text summary')
  })
  
  return server
}

// Run if called directly
if (require.main === module) {
  startServer()
}

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
import { applyChargingAction, checkConnection, verifyEntities, getFullStatus } from './ha-integration'
import { getDayHistory, getWeekHistory, findBestChargingWindows } from './history'
import { 
  getConfig, setConfig, resetConfig, 
  getActiveAlerts as getActiveAlertsLegacy, 
  getAlertHistory as getAlertHistoryLegacy, 
  acknowledgeAlert as acknowledgeAlertLegacy, 
  clearAlert, checkAlerts 
} from './alerts'
import {
  getLoadManagerConfig, setLoadManagerConfig,
  getLoadManagerState, updateState as updateLoadState,
  balanceLoads, addLoad, removeLoad, updateLoad,
  forceRestoreAll, setEnabled as setLoadManagerEnabled,
  shedLoad, restoreLoad, getLoadHistory, getLoadStatus,
} from './load-manager'
import {
  start as startScheduler,
  stop as stopScheduler,
  pause as pauseScheduler,
  resume as resumeScheduler,
  getState as getSchedulerState,
  getStats as getSchedulerStats,
  forceTick,
  clearCache as clearSchedulerCache,
  restart as restartScheduler,
} from './scheduler'
import {
  getRecentDecisions,
  getActiveAlerts as getActiveAlertsDb,
  getAlertHistory as getAlertHistoryDb,
  acknowledgeAlert as acknowledgeAlertDb,
  getDatabaseStats,
  cleanupOldData,
  getDb,
  getLoadActionHistory,
  getLoadActionStats,
  getShedLoads,
} from './storage'
import {
  loadConfig as loadAppConfig,
  updateConfig as updateAppConfig,
  resetConfig as resetAppConfig,
  validateConfig,
  getSchedulerConfig,
  getLoadsConfig,
} from './config'
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
  enabled?: boolean | string
  limit?: number
  reason?: string
  // Config fields
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
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
  scheduler: 0,
  decisions: 0,
  loads: 0,
}

// Routes
const routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>> = {
  
  // Prometheus metrics
  'GET /metrics': async (req, res) => {
    const schedulerState = getSchedulerState()
    const schedulerStats = getSchedulerStats()
    const dbStats = getDatabaseStats()
    const loadsConfig = getLoadsConfig()
    
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
      '# HELP voltassistant_scheduler_running Scheduler running status',
      '# TYPE voltassistant_scheduler_running gauge',
      `voltassistant_scheduler_running ${schedulerState.isRunning ? 1 : 0}`,
      '',
      '# HELP voltassistant_scheduler_paused Scheduler paused status',
      '# TYPE voltassistant_scheduler_paused gauge',
      `voltassistant_scheduler_paused ${schedulerState.isPaused ? 1 : 0}`,
      '',
      '# HELP voltassistant_scheduler_runs_total Total scheduler runs',
      '# TYPE voltassistant_scheduler_runs_total counter',
      `voltassistant_scheduler_runs_total ${schedulerStats.totalRuns}`,
      '',
      '# HELP voltassistant_scheduler_errors_total Total scheduler errors',
      '# TYPE voltassistant_scheduler_errors_total counter',
      `voltassistant_scheduler_errors_total ${schedulerStats.failedRuns}`,
      '',
      '# HELP voltassistant_decisions_total Total decisions in database',
      '# TYPE voltassistant_decisions_total gauge',
      `voltassistant_decisions_total ${dbStats.decisions}`,
      '',
      '# HELP voltassistant_active_alerts Active alerts count',
      '# TYPE voltassistant_active_alerts gauge',
      `voltassistant_active_alerts ${dbStats.activeAlerts}`,
      '',
      '# HELP voltassistant_load_manager_enabled Load manager enabled status',
      '# TYPE voltassistant_load_manager_enabled gauge',
      `voltassistant_load_manager_enabled ${loadsConfig.enabled ? 1 : 0}`,
      '',
      '# HELP voltassistant_loads_shed Currently shed loads count',
      '# TYPE voltassistant_loads_shed gauge',
      `voltassistant_loads_shed ${dbStats.shedLoads}`,
      '',
      '# HELP voltassistant_load_actions_total Load shed/restore actions',
      '# TYPE voltassistant_load_actions_total counter',
      `voltassistant_load_actions_total{action="shed"} ${schedulerStats.loadActionCounts.sheds}`,
      `voltassistant_load_actions_total{action="restore"} ${schedulerStats.loadActionCounts.restores}`,
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
    const schedulerState = getSchedulerState()
    const loadsConfig = getLoadsConfig()
    sendJSON(res, 200, { 
      status: 'ok', 
      version: '2.1.0', 
      timestamp: new Date().toISOString(),
      scheduler: {
        running: schedulerState.isRunning,
        paused: schedulerState.isPaused,
      },
      loadManager: {
        enabled: loadsConfig.enabled,
        devices: loadsConfig.devices.length,
      }
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULER ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Get scheduler status
  'GET /scheduler/status': async (req, res) => {
    requestCounts.scheduler++
    const state = getSchedulerState()
    const stats = getSchedulerStats()
    const config = getSchedulerConfig()
    
    sendJSON(res, 200, {
      success: true,
      state,
      stats,
      config,
    })
  },

  // Start scheduler
  'POST /scheduler/start': async (req, res) => {
    requestCounts.scheduler++
    const result = startScheduler()
    const state = getSchedulerState()
    
    sendJSON(res, 200, {
      success: result,
      message: result ? 'Scheduler iniciado' : 'Scheduler ya estaba corriendo',
      state,
    })
  },

  // Stop scheduler
  'POST /scheduler/stop': async (req, res) => {
    requestCounts.scheduler++
    const result = stopScheduler()
    const state = getSchedulerState()
    
    sendJSON(res, 200, {
      success: result,
      message: result ? 'Scheduler detenido' : 'Scheduler no estaba corriendo',
      state,
    })
  },

  // Pause scheduler
  'POST /scheduler/pause': async (req, res) => {
    requestCounts.scheduler++
    const result = pauseScheduler()
    const state = getSchedulerState()
    
    sendJSON(res, 200, {
      success: result,
      message: result ? 'Scheduler pausado' : 'No se pudo pausar',
      state,
    })
  },

  // Resume scheduler
  'POST /scheduler/resume': async (req, res) => {
    requestCounts.scheduler++
    const result = resumeScheduler()
    const state = getSchedulerState()
    
    sendJSON(res, 200, {
      success: result,
      message: result ? 'Scheduler reanudado' : 'No se pudo reanudar',
      state,
    })
  },

  // Force immediate tick
  'POST /scheduler/tick': async (req, res) => {
    requestCounts.scheduler++
    try {
      await forceTick()
      const state = getSchedulerState()
      sendJSON(res, 200, {
        success: true,
        message: 'Tick ejecutado',
        state,
      })
    } catch (error) {
      sendJSON(res, 500, {
        success: false,
        error: (error as Error).message,
      })
    }
  },

  // Restart scheduler with new config
  'POST /scheduler/restart': async (req, res) => {
    requestCounts.scheduler++
    const result = restartScheduler()
    const state = getSchedulerState()
    
    sendJSON(res, 200, {
      success: result,
      message: 'Scheduler reiniciado',
      state,
    })
  },

  // Clear scheduler cache
  'POST /scheduler/clear-cache': async (req, res) => {
    requestCounts.scheduler++
    clearSchedulerCache()
    sendJSON(res, 200, {
      success: true,
      message: 'Cache limpiado',
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DECISIONS ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Get decision history
  'GET /decisions': async (req, res) => {
    requestCounts.decisions++
    const url = new URL(req.url || '/', `http://localhost:${PORT}`)
    const limit = parseInt(url.searchParams.get('limit') || '50', 10)
    
    const decisions = getRecentDecisions(Math.min(limit, 500))
    
    sendJSON(res, 200, {
      success: true,
      count: decisions.length,
      decisions,
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // APP CONFIG ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Get app configuration
  'GET /config': async (req, res) => {
    const config = loadAppConfig()
    const validation = validateConfig(config)
    
    sendJSON(res, 200, {
      success: true,
      config,
      valid: validation.valid,
      errors: validation.errors,
    })
  },

  // Update app configuration
  'POST /config': async (req, res) => {
    try {
      const body = await parseBody(req)
      const updated = updateAppConfig(body as any)
      const validation = validateConfig(updated)
      
      sendJSON(res, 200, {
        success: true,
        config: updated,
        valid: validation.valid,
        errors: validation.errors,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Reset app configuration
  'POST /config/reset': async (req, res) => {
    const config = resetAppConfig()
    sendJSON(res, 200, {
      success: true,
      config,
      message: 'Configuración restablecida a valores por defecto',
    })
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // DATABASE ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Get database stats
  'GET /db/stats': async (req, res) => {
    const stats = getDatabaseStats()
    sendJSON(res, 200, {
      success: true,
      ...stats,
      sizeMB: Math.round(stats.sizeBytes / 1024 / 1024 * 100) / 100,
    })
  },

  // Cleanup old data
  'POST /db/cleanup': async (req, res) => {
    try {
      const body = await parseBody(req)
      const days = typeof body.days === 'number' ? body.days : 90
      const result = cleanupOldData(days)
      
      sendJSON(res, 200, {
        success: true,
        ...result,
        message: `Limpiados datos de más de ${days} días`,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HA INTEGRATION ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // Verify HA entities
  'GET /ha/verify': async (req, res) => {
    try {
      const result = await verifyEntities()
      sendJSON(res, 200, {
        success: true,
        ...result,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Get full HA status
  'GET /ha/status': async (req, res) => {
    try {
      const status = await getFullStatus()
      sendJSON(res, 200, {
        success: true,
        ...status,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD MANAGER ROUTES (New integrated endpoints)
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /loads - Get current state of all loads
  'GET /loads': async (req, res) => {
    requestCounts.loads++
    try {
      const state = await getLoadManagerState()
      sendJSON(res, 200, {
        success: true,
        enabled: state.enabled,
        totalLoads: state.totalConfiguredLoads,
        shedCount: state.shedLoads.length,
        activeCount: state.activeLoads.length,
        maxInverterPower: state.maxInverterPower,
        safetyMarginPercent: state.safetyMarginPercent,
        loads: state.allLoads,
        shedLoads: state.shedLoads,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // POST /loads/:id/shed - Force shed a specific load
  'POST /loads/shed': async (req, res) => {
    requestCounts.loads++
    try {
      const body = await parseBody(req)
      if (!body.id) {
        sendJSON(res, 400, { success: false, error: 'Missing device id' })
        return
      }
      
      const reason = (body.reason as string) || 'Desconexión manual forzada'
      const success = await shedLoad(body.id as string, reason, { soc: 50, price: 0.1 })
      
      sendJSON(res, 200, {
        success,
        message: success ? `Carga ${body.id} desconectada` : 'Error al desconectar carga',
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // POST /loads/:id/restore - Force restore a specific load
  'POST /loads/restore': async (req, res) => {
    requestCounts.loads++
    try {
      const body = await parseBody(req)
      
      // If no ID, restore all
      if (!body.id) {
        const restored = await forceRestoreAll({ soc: 50, price: 0.1 })
        sendJSON(res, 200, {
          success: true,
          message: 'Todas las cargas restauradas',
          restored,
        })
        return
      }
      
      const reason = (body.reason as string) || 'Reconexión manual forzada'
      const success = await restoreLoad(body.id as string, reason, { soc: 50, price: 0.1 })
      
      sendJSON(res, 200, {
        success,
        message: success ? `Carga ${body.id} restaurada` : 'Error al restaurar carga (puede que aún no haya pasado min_off_minutes)',
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // GET /loads/history - Get load action history
  'GET /loads/history': async (req, res) => {
    requestCounts.loads++
    try {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`)
      const limit = parseInt(url.searchParams.get('limit') || '100', 10)
      
      const history = getLoadActionHistory(Math.min(limit, 500))
      const stats = getLoadActionStats(7)
      
      sendJSON(res, 200, {
        success: true,
        count: history.length,
        stats,
        history,
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EXISTING LOAD MANAGER ROUTES (Legacy compatibility)
  // ═══════════════════════════════════════════════════════════════════════════

  // Get load manager status
  'GET /loads/status': async (req, res) => {
    requestCounts.loads++
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
    requestCounts.loads++
    try {
      const config = getLoadManagerConfig()
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Update load manager config
  'POST /loads/config': async (req, res) => {
    requestCounts.loads++
    try {
      const body = await parseBody(req)
      const config = setLoadManagerConfig(body as any)
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Add a load
  'POST /loads/add': async (req, res) => {
    requestCounts.loads++
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
    requestCounts.loads++
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
    requestCounts.loads++
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
    requestCounts.loads++
    try {
      const result = await balanceLoads()
      const state = await getLoadManagerState()
      sendJSON(res, 200, {
        success: true,
        ...result,
        state: {
          enabled: state.enabled,
          totalLoads: state.totalConfiguredLoads,
          shedLoads: state.shedLoads.map(l => l.id),
        },
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Force restore all shed loads
  'POST /loads/restore-all': async (req, res) => {
    requestCounts.loads++
    try {
      const restored = await forceRestoreAll()
      sendJSON(res, 200, { success: true, restored })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Enable/disable load manager
  'POST /loads/enable': async (req, res) => {
    requestCounts.loads++
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
    requestCounts.loads++
    try {
      const result = await balanceLoads()
      const state = await getLoadManagerState()
      
      // Return HA-friendly format
      sendJSON(res, 200, {
        balanced: true,
        actions_taken: result.actions.length,
        actions: result.actions,
        loads_affected: result.loadsAffected,
        is_enabled: state.enabled,
        shed_loads: state.shedLoads.map(l => ({ id: l.id, name: l.name, since: l.shed_since })),
      })
    } catch (error) {
      sendJSON(res, 500, { error: (error as Error).message })
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EXISTING ROUTES (unchanged)
  // ═══════════════════════════════════════════════════════════════════════════

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
      
      // Include scheduler and load manager status
      const schedulerState = getSchedulerState()
      const loadState = await getLoadManagerState()
      
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
        scheduler: {
          running: schedulerState.isRunning,
          last_action: schedulerState.lastAction,
          last_run: schedulerState.lastRun,
        },
        loads: {
          enabled: loadState.enabled,
          shed_count: loadState.shedLoads.length,
          shed_loads: loadState.shedLoads.map(l => l.id),
        }
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
      
      if (!action || !['charge', 'discharge', 'auto', 'idle'].includes(action as string)) {
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
      
      const result = await applyChargingAction(actionMap[action as string])
      
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
      
      // Add scheduler and load info
      const schedulerState = getSchedulerState()
      const loadState = await getLoadManagerState()
      
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
        scheduler: {
          running: schedulerState.isRunning,
          paused: schedulerState.isPaused,
          lastAction: schedulerState.lastAction,
          lastRun: schedulerState.lastRun,
          nextRun: schedulerState.nextRun,
          lastLoadActions: schedulerState.lastLoadActions,
        },
        loads: {
          enabled: loadState.enabled,
          totalLoads: loadState.totalConfiguredLoads,
          shedCount: loadState.shedLoads.length,
          shedLoads: loadState.shedLoads.map(l => ({ id: l.id, name: l.name, since: l.shed_since })),
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

  // Get alert configuration (legacy)
  'GET /alerts/config': async (req, res) => {
    sendJSON(res, 200, { success: true, config: getConfig() })
  },

  // Update alert configuration (legacy)
  'POST /alerts/config': async (req, res) => {
    try {
      const body = await parseBody(req)
      const config = setConfig(body as any)
      sendJSON(res, 200, { success: true, config })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Reset alert configuration to defaults (legacy)
  'POST /alerts/reset': async (req, res) => {
    sendJSON(res, 200, { success: true, config: resetConfig() })
  },

  // Get active alerts (from both legacy and SQLite)
  'GET /alerts': async (req, res) => {
    const legacyAlerts = getActiveAlertsLegacy()
    const dbAlerts = getActiveAlertsDb()
    
    sendJSON(res, 200, { 
      success: true, 
      count: legacyAlerts.length + dbAlerts.length,
      legacy: legacyAlerts,
      stored: dbAlerts,
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
        activeAlerts: getActiveAlertsLegacy(),
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
      
      // Try both legacy and DB
      let result = false
      if (typeof body.id === 'string') {
        result = acknowledgeAlertLegacy(body.id)
      }
      if (typeof body.id === 'number') {
        result = acknowledgeAlertDb(body.id)
      }
      
      sendJSON(res, 200, { success: result })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
    }
  },

  // Clear an alert (legacy)
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
      legacy: getAlertHistoryLegacy(limit),
      stored: getAlertHistoryDb(limit),
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
      
      const schedulerState = getSchedulerState()
      const loadState = await getLoadManagerState()
      
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
        '',
        `🤖 Scheduler: ${schedulerState.isRunning ? (schedulerState.isPaused ? 'pausado' : 'activo') : 'detenido'}`,
        schedulerState.lastAction ? `   Última acción: ${schedulerState.lastAction}` : '',
        '',
        `🔌 Cargas: ${loadState.enabled ? 'gestión activa' : 'deshabilitado'}`,
        loadState.shedLoads.length > 0 ? `   Desconectadas: ${loadState.shedLoads.map(l => l.name).join(', ')}` : '',
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
        report: lines.filter(Boolean).join('\n'),
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
          scheduler: schedulerState,
          loads: loadState,
        }
      })
    } catch (error) {
      sendJSON(res, 500, { success: false, error: (error as Error).message })
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
  // Initialize database
  getDb()
  
  const server = http.createServer(handleRequest)
  
  server.listen(PORT, () => {
    console.log(`⚡ VoltAssistant API Server v2.1`)
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
    console.log('🤖 Autonomous Scheduler:')
    console.log('   GET  /scheduler/status  - Scheduler state and stats')
    console.log('   POST /scheduler/start   - Start scheduler')
    console.log('   POST /scheduler/stop    - Stop scheduler')
    console.log('   POST /scheduler/pause   - Pause scheduler')
    console.log('   POST /scheduler/resume  - Resume scheduler')
    console.log('   POST /scheduler/tick    - Force immediate tick')
    console.log('   GET  /decisions         - Decision history')
    console.log('')
    console.log('⚙️ Configuration:')
    console.log('   GET  /config       - Get app configuration')
    console.log('   POST /config       - Update configuration')
    console.log('   GET  /ha/verify    - Verify HA entities')
    console.log('   GET  /ha/status    - Full HA status')
    console.log('   GET  /db/stats     - Database statistics')
    console.log('')
    console.log('🔌 Load Manager:')
    console.log('   GET  /loads          - Current state of all loads')
    console.log('   POST /loads/shed     - Force disconnect a load')
    console.log('   POST /loads/restore  - Force reconnect a load')
    console.log('   GET  /loads/history  - Load action history')
    console.log('   GET  /loads/config   - Get load config')
    console.log('   POST /loads/config   - Update load config')
    console.log('   POST /loads/add      - Add a load device')
    console.log('   PUT  /loads          - Update a load device')
    console.log('   DELETE /loads        - Remove a load device')
    console.log('   POST /loads/enable   - Enable/disable load manager')
    console.log('   POST /loads/restore-all - Restore all shed loads')
    console.log('   POST /webhook/loads  - HA webhook trigger')
    
    // Start scheduler if enabled
    const schedulerConfig = getSchedulerConfig()
    if (schedulerConfig.enabled) {
      console.log('')
      console.log('🚀 Iniciando scheduler autónomo...')
      startScheduler()
    } else {
      console.log('')
      console.log('ℹ️ Scheduler deshabilitado en config')
    }
    
    // Show load manager status
    const loadsConfig = getLoadsConfig()
    const deviceCount = loadsConfig.devices?.length || 0
    if (loadsConfig.enabled) {
      console.log(`🔌 Gestión de cargas ACTIVA (${deviceCount} dispositivos configurados)`)
    }
  })
  
  return server
}

// Run if called directly
if (require.main === module) {
  startServer()
}

/**
 * Autonomous Scheduler for VoltAssistant
 * Runs every N minutes to evaluate conditions, control the inverter,
 * and manage loads automatically based on SOC, prices, and solar production.
 */

import { getPVPCPrices, PVPCDay } from './pvpc'
import { getSolarForecast, SolarDay } from './solar'
import { getBatteryStatus, applyChargingAction, checkConnection, testConnection } from './ha-integration'
import { makeFullDecision, DecisionThresholds, DEFAULT_THRESHOLDS, BatteryAction, explainDecision } from './decision-engine'
import { saveDecision, updateDecisionExecution, getLastDecision, saveHourlyStat, Decision } from './storage'
import { loadConfig, SchedulerConfig, getLoadsConfig } from './config'
import { executeLoadActions, LoadEvaluationResult, getLoadManagerState } from './load-manager'

export interface SchedulerState {
  isRunning: boolean
  isPaused: boolean
  lastRun: string | null
  lastAction: BatteryAction | null
  lastReason: string | null
  nextRun: string | null
  runCount: number
  errorCount: number
  consecutiveErrors: number
  lastError: string | null
  lastLoadActions: string[]
}

export interface SchedulerStats {
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  actionCounts: Record<BatteryAction, number>
  loadActionCounts: { sheds: number; restores: number }
  uptime: number // ms
}

// Scheduler singleton state
let state: SchedulerState = {
  isRunning: false,
  isPaused: false,
  lastRun: null,
  lastAction: null,
  lastReason: null,
  nextRun: null,
  runCount: 0,
  errorCount: 0,
  consecutiveErrors: 0,
  lastError: null,
  lastLoadActions: [],
}

let stats: SchedulerStats = {
  totalRuns: 0,
  successfulRuns: 0,
  failedRuns: 0,
  actionCounts: {
    charge_from_grid: 0,
    charge_from_solar: 0,
    discharge: 0,
    idle: 0,
  },
  loadActionCounts: { sheds: 0, restores: 0 },
  uptime: 0,
}

let intervalHandle: NodeJS.Timeout | null = null
let startTime: number = 0
let cachedPrices: PVPCDay | null = null
let cachedSolar: SolarDay | null = null
let cacheDate: string | null = null

/**
 * Main scheduler tick - evaluates conditions, takes battery action, and manages loads
 */
async function tick(): Promise<void> {
  if (state.isPaused) {
    console.log('⏸️ Scheduler pausado, saltando tick')
    return
  }
  
  const now = new Date()
  const nowStr = now.toISOString()
  const dateStr = nowStr.split('T')[0]
  const currentHour = now.getHours()
  
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`⚡ Scheduler tick: ${nowStr}`)
  console.log(`${'═'.repeat(60)}`)
  
  state.runCount++
  stats.totalRuns++
  
  try {
    // Load config
    const config = loadConfig()
    const thresholds: DecisionThresholds = {
      ...DEFAULT_THRESHOLDS,
      ...config.thresholds,
    }
    
    // Check HA connection first
    const haConnected = await testConnection()
    if (!haConnected) {
      throw new Error('Home Assistant no disponible')
    }
    
    // Get current battery status from HA
    const batteryStatus = await getBatteryStatus()
    if (!batteryStatus) {
      throw new Error('No se pudo obtener estado de batería')
    }
    
    console.log(`🔋 Estado actual: SOC=${batteryStatus.soc}%, Solar=${batteryStatus.solarPower}W, Load=${batteryStatus.loadPower}W, Grid=${batteryStatus.gridPower}W`)
    
    // Refresh price/solar cache if needed (once per day or if missing)
    if (cacheDate !== dateStr || !cachedPrices || !cachedSolar) {
      console.log('📊 Actualizando datos de precios y solar...')
      const [prices, solar] = await Promise.all([
        getPVPCPrices(now),
        getSolarForecast(now),
      ])
      cachedPrices = prices
      cachedSolar = solar
      cacheDate = dateStr
      console.log(`   Precio medio: ${(prices.averagePrice * 100).toFixed(2)}¢/kWh`)
      console.log(`   Solar previsto: ${Math.round(solar.totalWh / 1000)}kWh`)
    }
    
    // Get current price and solar forecast for this hour
    const currentPrice = cachedPrices.prices.find(p => p.hour === currentHour)?.price || cachedPrices.averagePrice
    const currentSolarForecast = cachedSolar.forecasts.find(f => f.hour === currentHour)?.watts || 0
    
    // Make full decision (battery + loads)
    const { batteryDecision, loadActions } = await makeFullDecision({
      currentSoc: batteryStatus.soc,
      currentPrice,
      currentSolarWatts: batteryStatus.solarPower,
      currentLoadWatts: batteryStatus.loadPower,
      currentHour,
      pricesDay: cachedPrices,
      solarDay: cachedSolar,
      thresholds,
    })
    
    console.log(`\n${explainDecision(batteryDecision)}`)
    
    // Check if action changed from last run
    const lastDecision = getLastDecision()
    const actionChanged = !lastDecision || lastDecision.action !== batteryDecision.action
    
    // Save decision to database
    const decisionRecord: Decision = {
      timestamp: nowStr,
      soc: batteryStatus.soc,
      price: currentPrice,
      solar_watts: batteryStatus.solarPower,
      action: batteryDecision.action,
      reason: batteryDecision.reason,
      executed: false,
    }
    const decisionId = saveDecision(decisionRecord)
    
    // Execute battery action (only if changed or force refresh every 4 ticks)
    const shouldExecute = actionChanged || (state.runCount % 4 === 0)
    
    if (shouldExecute) {
      console.log(`\n🎯 Ejecutando acción batería: ${batteryDecision.action}`)
      const success = await applyChargingAction(batteryDecision.action)
      
      if (success) {
        updateDecisionExecution(decisionId, true)
        console.log('✅ Acción de batería ejecutada correctamente')
      } else {
        updateDecisionExecution(decisionId, false, 'Error al aplicar acción en HA')
        console.error('❌ Error al ejecutar acción de batería')
      }
    } else {
      console.log(`\n⏭️ Acción batería sin cambios (${batteryDecision.action}), no se ejecuta`)
      updateDecisionExecution(decisionId, true)
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LOAD MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════
    
    const loadsConfig = getLoadsConfig()
    state.lastLoadActions = []
    
    if (loadsConfig.enabled && loadActions.length > 0) {
      console.log(`\n🔌 Gestión de cargas:`)
      
      for (const action of loadActions) {
        console.log(`   ${action.action === 'shed' ? '⬇️' : '⬆️'} ${action.reason}`)
        console.log(`      Dispositivos: ${action.devices.join(', ')}`)
      }
      
      // Execute load actions
      const { executed, failed } = await executeLoadActions(loadActions, {
        soc: batteryStatus.soc,
        price: currentPrice,
        solarWatts: batteryStatus.solarPower,
        loadWatts: batteryStatus.loadPower,
      })
      
      state.lastLoadActions = executed
      
      // Update stats
      for (const action of executed) {
        if (action.startsWith('shed:')) {
          stats.loadActionCounts.sheds++
        } else if (action.startsWith('restore:')) {
          stats.loadActionCounts.restores++
        }
      }
      
      if (executed.length > 0) {
        console.log(`✅ Cargas gestionadas: ${executed.join(', ')}`)
      }
      if (failed.length > 0) {
        console.log(`⚠️ Cargas fallidas: ${failed.join(', ')}`)
      }
    } else if (loadsConfig.enabled) {
      // No actions needed, show current state
      const loadState = await getLoadManagerState()
      if (loadState.shedLoads.length > 0) {
        console.log(`\n🔌 Cargas desconectadas: ${loadState.shedLoads.map(l => l.name).join(', ')}`)
      }
    }
    
    // Save hourly stats (at minute 0 or first run of the hour)
    const minute = now.getMinutes()
    if (minute < 15) { // First tick of the hour
      saveHourlyStat({
        date: dateStr,
        hour: currentHour,
        price: currentPrice,
        solar_kwh: batteryStatus.solarPower / 1000, // Approximate
        consumption_kwh: batteryStatus.loadPower / 1000,
        grid_import_kwh: Math.max(0, batteryStatus.gridPower) / 1000,
        grid_export_kwh: Math.max(0, -batteryStatus.gridPower) / 1000,
        battery_soc: batteryStatus.soc,
      })
    }
    
    // Update state
    state.lastRun = nowStr
    state.lastAction = batteryDecision.action
    state.lastReason = batteryDecision.reason
    state.consecutiveErrors = 0
    state.lastError = null
    
    stats.successfulRuns++
    stats.actionCounts[batteryDecision.action]++
    
  } catch (error) {
    const errorMsg = (error as Error).message
    console.error(`\n❌ Error en scheduler: ${errorMsg}`)
    
    state.errorCount++
    state.consecutiveErrors++
    state.lastError = errorMsg
    state.lastRun = nowStr
    
    stats.failedRuns++
    
    // If too many consecutive errors, pause and alert
    if (state.consecutiveErrors >= 5) {
      console.error('🚨 Demasiados errores consecutivos, pausando scheduler')
      pause()
    }
  }
  
  // Schedule next run display
  const config = loadConfig()
  const nextRunTime = new Date(now.getTime() + config.scheduler.interval_minutes * 60 * 1000)
  state.nextRun = nextRunTime.toISOString()
  
  console.log(`\n⏰ Próxima ejecución: ${nextRunTime.toLocaleTimeString('es-ES')}`)
  console.log(`${'═'.repeat(60)}\n`)
}

/**
 * Start the scheduler
 */
export function start(): boolean {
  if (state.isRunning) {
    console.log('⚠️ Scheduler ya está corriendo')
    return false
  }
  
  const config = loadConfig()
  const intervalMs = config.scheduler.interval_minutes * 60 * 1000
  
  console.log(`\n🚀 Iniciando scheduler autónomo`)
  console.log(`   Intervalo: ${config.scheduler.interval_minutes} minutos`)
  console.log(`   Umbrales: SOC mín=${config.thresholds.min_soc}%, máx=${config.thresholds.max_soc}%`)
  console.log(`   Percentiles precio: bajo=P${config.thresholds.price_percentile_low}, alto=P${config.thresholds.price_percentile_high}`)
  
  // Load management status
  const loadsConfig = getLoadsConfig()
  const deviceCount = loadsConfig.devices?.length || 0
  if (loadsConfig.enabled) {
    console.log(`   Gestión cargas: ACTIVA (${deviceCount} dispositivos)`)
  } else {
    console.log(`   Gestión cargas: deshabilitada`)
  }
  
  state.isRunning = true
  state.isPaused = false
  startTime = Date.now()
  
  // Run immediately
  tick().catch(console.error)
  
  // Then run on interval
  intervalHandle = setInterval(() => {
    tick().catch(console.error)
  }, intervalMs)
  
  return true
}

/**
 * Stop the scheduler completely
 */
export function stop(): boolean {
  if (!state.isRunning) {
    console.log('⚠️ Scheduler no está corriendo')
    return false
  }
  
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  
  state.isRunning = false
  state.isPaused = false
  stats.uptime += Date.now() - startTime
  
  console.log('⏹️ Scheduler detenido')
  return true
}

/**
 * Pause the scheduler (keeps running but skips ticks)
 */
export function pause(): boolean {
  if (!state.isRunning) {
    console.log('⚠️ Scheduler no está corriendo')
    return false
  }
  
  if (state.isPaused) {
    console.log('⚠️ Scheduler ya está pausado')
    return false
  }
  
  state.isPaused = true
  console.log('⏸️ Scheduler pausado')
  return true
}

/**
 * Resume the scheduler
 */
export function resume(): boolean {
  if (!state.isRunning) {
    console.log('⚠️ Scheduler no está corriendo')
    return false
  }
  
  if (!state.isPaused) {
    console.log('⚠️ Scheduler no está pausado')
    return false
  }
  
  state.isPaused = false
  state.consecutiveErrors = 0 // Reset error count on resume
  console.log('▶️ Scheduler reanudado')
  
  // Run immediately after resume
  tick().catch(console.error)
  
  return true
}

/**
 * Force a manual tick (ignores pause)
 */
export async function forceTick(): Promise<void> {
  const wasPaused = state.isPaused
  state.isPaused = false
  await tick()
  state.isPaused = wasPaused
}

/**
 * Get current scheduler state
 */
export function getState(): SchedulerState {
  return { ...state }
}

/**
 * Get scheduler statistics
 */
export function getStats(): SchedulerStats {
  const currentUptime = state.isRunning ? Date.now() - startTime : 0
  return {
    ...stats,
    uptime: stats.uptime + currentUptime,
  }
}

/**
 * Clear cached data (forces refresh on next tick)
 */
export function clearCache(): void {
  cachedPrices = null
  cachedSolar = null
  cacheDate = null
  console.log('🗑️ Cache limpiado')
}

/**
 * Restart scheduler with new config
 */
export function restart(): boolean {
  const wasRunning = state.isRunning
  
  if (wasRunning) {
    stop()
  }
  
  clearCache()
  
  if (wasRunning) {
    return start()
  }
  
  return true
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📴 Recibida señal SIGTERM, deteniendo scheduler...')
  stop()
})

process.on('SIGINT', () => {
  console.log('📴 Recibida señal SIGINT, deteniendo scheduler...')
  stop()
})

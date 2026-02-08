/**
 * Intelligent Decision Engine for VoltAssistant
 * Evaluates current conditions and determines optimal battery action
 * 
 * Simplified Control Strategy (using Program 1):
 * - Price < P20 AND SOC < 80% → Grid charging, target 80%
 * - Solar > 500W → Disabled (solar only)
 * - SOC < 15% (emergency) → Grid charging, target 30%
 * - Price > P80 → Disabled, target 15%
 */

import { PVPCDay } from './pvpc'
import { SolarDay } from './solar'
import { LoadEvaluationContext, LoadEvaluationResult, evaluateLoads } from './load-manager'

export type BatteryAction = 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle'

// Simplified control decision
export interface SimpleControlDecision {
  targetSoc: number  // 0 = no grid charge, 30/80/95 = charge to that %
  reason: string
  pricePercentile: number
}

export interface DecisionContext {
  // Current state
  currentSoc: number           // 0-100
  currentPrice: number         // €/kWh
  currentSolarWatts: number    // Current solar production
  currentLoadWatts: number     // Current consumption
  currentHour: number          // 0-23
  
  // Forecasts
  pricesDay: PVPCDay           // Full day prices
  solarDay: SolarDay           // Full day solar forecast
  
  // Configuration
  thresholds: DecisionThresholds
}

export interface DecisionThresholds {
  min_soc: number              // Emergency minimum (default: 15%)
  max_soc: number              // Maximum charge target (default: 95%)
  emergency_soc: number        // Force charge below this (default: 15%)
  target_soc: number           // Target for grid charging (default: 80%)
  price_percentile_low: number // Cheap price threshold (default: 20)
  price_percentile_high: number // Expensive price threshold (default: 80)
  min_solar_watts_for_charge: number // Min solar to consider solar charging (default: 500W)
}

export interface DecisionResult {
  action: BatteryAction
  reason: string
  confidence: number           // 0-1, how confident in this decision
  factors: DecisionFactor[]    // Contributing factors
  nextReviewHour?: number      // When to re-evaluate (if significant change expected)
  pricePercentile: number      // Current price percentile (for load manager)
}

export interface DecisionFactor {
  name: string
  value: string
  weight: number               // How much this factor influenced the decision
  favorable: boolean           // Is this factor favorable for the chosen action?
}

// Default thresholds
export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  min_soc: 15,
  max_soc: 95,
  emergency_soc: 15,
  target_soc: 80,
  price_percentile_low: 20,
  price_percentile_high: 80,
  min_solar_watts_for_charge: 500,
}

/**
 * Calculate price percentile for current hour
 */
export function calculatePricePercentile(currentPrice: number, prices: PVPCDay): number {
  const allPrices = prices.prices.map(p => p.price).sort((a, b) => a - b)
  const index = allPrices.findIndex(p => p >= currentPrice)
  if (index === -1) return 100
  return Math.round((index / allPrices.length) * 100)
}

/**
 * Get upcoming hours with low prices
 */
function getUpcomingCheapHours(currentHour: number, prices: PVPCDay, percentile: number): number[] {
  const threshold = getPercentilePrice(prices, percentile)
  return prices.prices
    .filter(p => p.hour > currentHour && p.price <= threshold)
    .map(p => p.hour)
}

/**
 * Get price at given percentile
 */
function getPercentilePrice(prices: PVPCDay, percentile: number): number {
  const sorted = [...prices.prices].sort((a, b) => a.price - b.price)
  const index = Math.floor((percentile / 100) * sorted.length)
  return sorted[Math.min(index, sorted.length - 1)].price
}

/**
 * Calculate expected solar production for remaining hours
 */
function getRemainingDaySolarWh(currentHour: number, solar: SolarDay): number {
  return solar.forecasts
    .filter(f => f.hour >= currentHour)
    .reduce((sum, f) => sum + f.watts, 0)
}

/**
 * Estimate hours until next solar production
 */
function hoursUntilSolar(currentHour: number, solar: SolarDay, minWatts: number): number {
  for (let h = currentHour; h < 24; h++) {
    const forecast = solar.forecasts.find(f => f.hour === h)
    if (forecast && forecast.watts >= minWatts) {
      return h - currentHour
    }
  }
  // No solar today, check tomorrow (estimate: around 7-8am)
  return (24 - currentHour) + 8
}

/**
 * Main decision function - evaluates all factors and returns optimal action
 */
export function makeDecision(context: DecisionContext): DecisionResult {
  const { 
    currentSoc, currentPrice, currentSolarWatts, currentLoadWatts,
    currentHour, pricesDay, solarDay, thresholds 
  } = context
  
  const factors: DecisionFactor[] = []
  
  // Calculate key metrics
  const pricePercentile = calculatePricePercentile(currentPrice, pricesDay)
  const lowPriceThreshold = getPercentilePrice(pricesDay, thresholds.price_percentile_low)
  const highPriceThreshold = getPercentilePrice(pricesDay, thresholds.price_percentile_high)
  const remainingSolarWh = getRemainingDaySolarWh(currentHour, solarDay)
  const hoursToSolar = hoursUntilSolar(currentHour, solarDay, thresholds.min_solar_watts_for_charge)
  const upcomingCheapHours = getUpcomingCheapHours(currentHour, pricesDay, thresholds.price_percentile_low)
  
  // Add analysis factors
  factors.push({
    name: 'SOC',
    value: `${currentSoc}%`,
    weight: currentSoc < thresholds.emergency_soc ? 1.0 : 0.3,
    favorable: currentSoc >= thresholds.min_soc && currentSoc <= thresholds.target_soc,
  })
  
  factors.push({
    name: 'Price Percentile',
    value: `P${pricePercentile} (${(currentPrice * 100).toFixed(1)}¢/kWh)`,
    weight: 0.4,
    favorable: pricePercentile <= thresholds.price_percentile_low,
  })
  
  factors.push({
    name: 'Solar Production',
    value: `${currentSolarWatts}W now, ${Math.round(remainingSolarWh / 1000)}kWh remaining`,
    weight: 0.3,
    favorable: currentSolarWatts >= thresholds.min_solar_watts_for_charge,
  })
  
  // ═══════════════════════════════════════════════════════════════════════════
  // DECISION LOGIC (Priority order)
  // ═══════════════════════════════════════════════════════════════════════════
  
  // 1. EMERGENCY: SOC critically low - charge from grid regardless of price
  if (currentSoc < thresholds.emergency_soc) {
    return {
      action: 'charge_from_grid',
      reason: `⚠️ EMERGENCIA: SOC crítico (${currentSoc}%) - carga forzada desde red`,
      confidence: 1.0,
      factors,
      nextReviewHour: undefined, // Keep charging until safe
      pricePercentile,
    }
  }
  
  // 2. SOLAR AVAILABLE: Sufficient solar production, charge from solar
  if (currentSolarWatts >= thresholds.min_solar_watts_for_charge) {
    const excessSolar = currentSolarWatts - currentLoadWatts
    
    // If there's excess solar and battery not full
    if (excessSolar > 0 && currentSoc < thresholds.max_soc) {
      return {
        action: 'charge_from_solar',
        reason: `☀️ Cargando de solar: ${currentSolarWatts}W producción, ${excessSolar}W excedente`,
        confidence: 0.95,
        factors,
        nextReviewHour: solarDay.forecasts.find(f => f.hour > currentHour && f.watts < thresholds.min_solar_watts_for_charge)?.hour,
        pricePercentile,
      }
    }
    
    // Solar covers consumption, just idle
    if (excessSolar >= -100) { // Small deficit is OK
      return {
        action: 'idle',
        reason: `☀️ Solar cubre consumo: ${currentSolarWatts}W vs ${currentLoadWatts}W demanda`,
        confidence: 0.85,
        factors,
        pricePercentile,
      }
    }
  }
  
  // 3. CHEAP PRICE: Price is very low, good time to charge from grid
  if (pricePercentile <= thresholds.price_percentile_low && currentSoc < thresholds.target_soc) {
    // Check if there's cheaper hours coming
    const cheaperAhead = upcomingCheapHours.some(h => {
      const futurePrice = pricesDay.prices.find(p => p.hour === h)?.price || Infinity
      return futurePrice < currentPrice * 0.9 // 10% cheaper
    })
    
    if (!cheaperAhead || currentSoc < 30) {
      return {
        action: 'charge_from_grid',
        reason: `💚 Precio bajo (P${pricePercentile}): ${(currentPrice * 100).toFixed(1)}¢/kWh - cargando de red`,
        confidence: 0.9,
        factors,
        nextReviewHour: pricesDay.prices.find(p => p.hour > currentHour && p.price > highPriceThreshold)?.hour,
        pricePercentile,
      }
    } else {
      // Wait for even cheaper hours, but don't risk running low
      factors.push({
        name: 'Strategy',
        value: `Esperando horas más baratas (${upcomingCheapHours.join(', ')})`,
        weight: 0.2,
        favorable: true,
      })
    }
  }
  
  // 4. EXPENSIVE PRICE: Price is high, discharge/sell if we have capacity
  if (pricePercentile >= thresholds.price_percentile_high && currentSoc > thresholds.min_soc + 15) {
    // Check if there's solar coming soon that we should preserve capacity for
    const solarComingSoon = hoursToSolar <= 2
    
    // Ensure we keep enough for the night if no cheap hours coming
    const cheapHoursTonight = upcomingCheapHours.filter(h => h >= 22 || h <= 6)
    const safeToDischarge = currentSoc > 40 || cheapHoursTonight.length > 0
    
    if (!solarComingSoon && safeToDischarge) {
      return {
        action: 'discharge',
        reason: `💰 Precio alto (P${pricePercentile}): ${(currentPrice * 100).toFixed(1)}¢/kWh - vendiendo/descargando`,
        confidence: 0.85,
        factors,
        nextReviewHour: pricesDay.prices.find(p => p.hour > currentHour && p.price < lowPriceThreshold)?.hour,
        pricePercentile,
      }
    }
  }
  
  // 5. PRE-EMPTIVE CHARGING: Night time, cheap hours, prepare for tomorrow
  if (currentHour >= 0 && currentHour <= 6) {
    if (pricePercentile <= thresholds.price_percentile_low + 10 && currentSoc < thresholds.target_soc) {
      return {
        action: 'charge_from_grid',
        reason: `🌙 Carga nocturna: precio favorable (P${pricePercentile}) y SOC ${currentSoc}%`,
        confidence: 0.75,
        factors,
        nextReviewHour: 7, // Review when solar might start
        pricePercentile,
      }
    }
  }
  
  // 6. WAIT FOR BETTER OPPORTUNITY: Default to idle
  // Analyze why we're idling
  let idleReason = '⏸️ Modo espera: '
  const idleReasons: string[] = []
  
  if (currentSoc >= thresholds.target_soc) {
    idleReasons.push(`batería llena (${currentSoc}%)`)
  }
  if (pricePercentile > thresholds.price_percentile_low && pricePercentile < thresholds.price_percentile_high) {
    idleReasons.push(`precio medio (P${pricePercentile})`)
  }
  if (currentSolarWatts > 0 && currentSolarWatts < thresholds.min_solar_watts_for_charge) {
    idleReasons.push(`solar insuficiente (${currentSolarWatts}W)`)
  }
  if (upcomingCheapHours.length > 0) {
    idleReasons.push(`esperando horas baratas (${upcomingCheapHours.slice(0, 3).map(h => h + ':00').join(', ')})`)
  }
  
  if (idleReasons.length === 0) {
    idleReasons.push('condiciones óptimas, conservando energía')
  }
  
  return {
    action: 'idle',
    reason: idleReason + idleReasons.join(', '),
    confidence: 0.7,
    factors,
    nextReviewHour: Math.min(
      ...upcomingCheapHours.slice(0, 1),
      currentHour + 1
    ),
    pricePercentile,
  }
}

/**
 * Quick evaluation - just returns action without full analysis
 */
export function quickDecision(
  soc: number,
  price: number,
  solarWatts: number,
  pricesDay: PVPCDay,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): BatteryAction {
  // Emergency
  if (soc < thresholds.emergency_soc) return 'charge_from_grid'
  
  // Good solar
  if (solarWatts >= thresholds.min_solar_watts_for_charge && soc < thresholds.max_soc) {
    return 'charge_from_solar'
  }
  
  const pricePercentile = calculatePricePercentile(price, pricesDay)
  
  // Cheap - charge
  if (pricePercentile <= thresholds.price_percentile_low && soc < thresholds.target_soc) {
    return 'charge_from_grid'
  }
  
  // Expensive - discharge
  if (pricePercentile >= thresholds.price_percentile_high && soc > thresholds.min_soc + 15) {
    return 'discharge'
  }
  
  return 'idle'
}

/**
 * Make simplified control decision
 * Uses the new Program 1 strategy with clear rules
 */
export function makeSimpleDecision(
  soc: number,
  price: number,
  solarWatts: number,
  pricesDay: PVPCDay,
  thresholds: DecisionThresholds = DEFAULT_THRESHOLDS
): SimpleControlDecision {
  const pricePercentile = calculatePricePercentile(price, pricesDay)
  
  // Rule 1: EMERGENCY - SOC < 15% → Force grid charging to 30%
  if (soc < thresholds.emergency_soc) {
    return {
      
      targetSoc: 30,
      reason: `⚠️ EMERGENCY: SOC critical (${soc}%) - forcing grid charge to 30%`,
      pricePercentile,
    }
  }
  
  // Rule 2: CHEAP PRICE - Price < P20 AND SOC < 80% → Grid charging to 80%
  if (pricePercentile <= thresholds.price_percentile_low && soc < thresholds.target_soc) {
    return {
      
      targetSoc: thresholds.target_soc,
      reason: `💚 Cheap price (P${pricePercentile}, ${(price * 100).toFixed(1)}¢) - grid charging to ${thresholds.target_soc}%`,
      pricePercentile,
    }
  }
  
  // Rule 3: SOLAR AVAILABLE - Solar > 500W → Disable grid charging (solar only)
  if (solarWatts >= thresholds.min_solar_watts_for_charge) {
    return {
      
      targetSoc: thresholds.max_soc,
      reason: `☀️ Solar available (${solarWatts}W) - solar only charging to ${thresholds.max_soc}%`,
      pricePercentile,
    }
  }
  
  // Rule 4: EXPENSIVE PRICE - Price > P80 → Disable grid charging, low target
  if (pricePercentile >= thresholds.price_percentile_high) {
    return {
      
      targetSoc: thresholds.min_soc,
      reason: `💰 Expensive price (P${pricePercentile}, ${(price * 100).toFixed(1)}¢) - discharge allowed`,
      pricePercentile,
    }
  }
  
  // Rule 5: DEFAULT - Normal conditions, disable grid charging, moderate target
  return {
    
    targetSoc: 50,
    reason: `⏸️ Normal conditions (P${pricePercentile}, SOC ${soc}%, Solar ${solarWatts}W) - standby`,
    pricePercentile,
  }
}

/**
 * Evaluate both battery decision and load management
 * Returns battery decision + load actions to execute
 */
export async function makeFullDecision(context: DecisionContext): Promise<{
  batteryDecision: DecisionResult
  loadActions: LoadEvaluationResult[]
}> {
  // Make battery decision
  const batteryDecision = makeDecision(context)
  
  // Prepare load evaluation context
  const loadContext: LoadEvaluationContext = {
    soc: context.currentSoc,
    price: context.currentPrice,
    pricePercentile: batteryDecision.pricePercentile,
    solarPower: context.currentSolarWatts,
    loadPower: context.currentLoadWatts,
  }
  
  // Evaluate loads
  const loadActions = await evaluateLoads(loadContext)
  
  return {
    batteryDecision,
    loadActions,
  }
}

/**
 * Explain the current decision in human-readable format
 */
export function explainDecision(result: DecisionResult): string {
  const lines: string[] = [
    `🤖 Decisión: ${actionToSpanish(result.action)}`,
    `📊 Confianza: ${Math.round(result.confidence * 100)}%`,
    `💡 Razón: ${result.reason}`,
    '',
    '📈 Factores analizados:',
  ]
  
  for (const factor of result.factors) {
    const icon = factor.favorable ? '✅' : '⚠️'
    lines.push(`  ${icon} ${factor.name}: ${factor.value}`)
  }
  
  if (result.nextReviewHour !== undefined) {
    lines.push('')
    lines.push(`⏰ Próxima revisión: ${result.nextReviewHour}:00`)
  }
  
  return lines.join('\n')
}

function actionToSpanish(action: BatteryAction): string {
  const map: Record<BatteryAction, string> = {
    'charge_from_grid': '🔌 Cargar de red',
    'charge_from_solar': '☀️ Cargar de solar',
    'discharge': '📤 Descargar/Vender',
    'idle': '⏸️ Espera',
  }
  return map[action]
}

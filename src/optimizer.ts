/**
 * Battery Charging Optimizer
 * Combines PVPC prices + solar forecast to determine optimal charging strategy
 */

import { PVPCDay, PVPCPrice, findBestChargingWindow, formatPrice } from './pvpc'
import { SolarDay, SolarForecast } from './solar'

export interface BatteryConfig {
  capacityWh: number // Total battery capacity in Wh
  maxChargeRateW: number // Maximum charge rate in W
  minSoC: number // Minimum state of charge (0-1)
  maxSoC: number // Maximum state of charge (0-1)
  currentSoC: number // Current state of charge (0-1)
}

// Default config for typical home battery with Deye inverter
const DEFAULT_BATTERY: BatteryConfig = {
  capacityWh: 10000, // 10kWh battery
  maxChargeRateW: 3000, // 3kW charge rate
  minSoC: 0.1, // 10% minimum
  maxSoC: 1.0, // 100% maximum
  currentSoC: 0.5, // Start at 50%
}

export interface ChargingDecision {
  action: 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle'
  reason: string
  priority: 'high' | 'medium' | 'low'
}

export interface HourlyPlan {
  hour: number
  price: number
  solarWatts: number
  decision: ChargingDecision
  expectedSoC: number
}

export interface DailyPlan {
  date: string
  hourlyPlan: HourlyPlan[]
  gridChargeHours: number[]
  gridChargeCost: number
  solarChargeWh: number
  gridExportWh: number
  savings: number
  recommendations: string[]
}

/**
 * Generate optimal charging plan for the day
 */
export function generateChargingPlan(
  pvpc: PVPCDay,
  solar: SolarDay,
  battery: BatteryConfig = DEFAULT_BATTERY,
  consumptionPattern?: number[]
): DailyPlan {
  // Default consumption pattern (Wh per hour)
  const consumption = consumptionPattern || [
    200, 150, 150, 150, 150, 200, // 00-05: Night
    400, 600, 500, 400, 300, 300, // 06-11: Morning
    400, 300, 300, 400, 500, 800, // 12-17: Afternoon
    1200, 1000, 800, 600, 400, 250, // 18-23: Evening peak
  ]
  
  const hourlyPlan: HourlyPlan[] = []
  let currentSoC = battery.currentSoC
  let gridChargeWh = 0
  let solarChargeWh = 0
  let gridExportWh = 0
  const gridChargeHours: number[] = []
  
  // Calculate price thresholds
  const avgPrice = pvpc.averagePrice
  const lowPriceThreshold = avgPrice * 0.7 // 30% below average
  const highPriceThreshold = avgPrice * 1.3 // 30% above average
  
  // Find hours where grid charging makes sense
  const cheapHours = pvpc.prices
    .filter(p => p.price < lowPriceThreshold)
    .map(p => p.hour)
    .sort((a, b) => a - b)
  
  for (let hour = 0; hour < 24; hour++) {
    const price = pvpc.prices[hour]?.price || avgPrice
    const solarWatts = solar.forecasts[hour]?.watts || 0
    const consumptionWh = consumption[hour]
    
    // Current energy state
    const currentWh = currentSoC * battery.capacityWh
    const maxChargeWh = battery.maxChargeRateW
    const targetWh = battery.maxSoC * battery.capacityWh
    const minWh = battery.minSoC * battery.capacityWh
    
    let decision: ChargingDecision
    
    // Decision logic
    if (solarWatts > consumptionWh) {
      // Excess solar - charge battery or export
      const excessWh = solarWatts - consumptionWh
      const chargeAmount = Math.min(excessWh, targetWh - currentWh)
      
      if (chargeAmount > 100) {
        decision = {
          action: 'charge_from_solar',
          reason: `Charging from solar (${Math.round(solarWatts)}W production)`,
          priority: 'high',
        }
        solarChargeWh += chargeAmount
        currentSoC = Math.min(battery.maxSoC, (currentWh + chargeAmount) / battery.capacityWh)
        gridExportWh += excessWh - chargeAmount
      } else {
        decision = {
          action: 'idle',
          reason: 'Solar covers consumption, battery full',
          priority: 'low',
        }
        gridExportWh += excessWh
      }
    } else if (price < lowPriceThreshold && currentSoC < 0.9) {
      // Cheap electricity - charge from grid
      const chargeAmount = Math.min(maxChargeWh, targetWh - currentWh)
      
      decision = {
        action: 'charge_from_grid',
        reason: `Low price (${formatPrice(price)}) - charging from grid`,
        priority: 'high',
      }
      gridChargeWh += chargeAmount
      gridChargeHours.push(hour)
      currentSoC = Math.min(battery.maxSoC, (currentWh + chargeAmount) / battery.capacityWh)
    } else if (price > highPriceThreshold && currentSoC > battery.minSoC + 0.2) {
      // Expensive electricity - use battery
      const dischargeAmount = Math.min(consumptionWh - solarWatts, currentWh - minWh)
      
      decision = {
        action: 'discharge',
        reason: `High price (${formatPrice(price)}) - using battery`,
        priority: 'high',
      }
      currentSoC = Math.max(battery.minSoC, (currentWh - dischargeAmount) / battery.capacityWh)
    } else {
      // Normal operation
      const netConsumption = consumptionWh - solarWatts
      if (netConsumption > 0 && currentSoC > battery.minSoC) {
        const dischargeAmount = Math.min(netConsumption, currentWh - minWh)
        currentSoC = (currentWh - dischargeAmount) / battery.capacityWh
        decision = {
          action: 'discharge',
          reason: 'Normal discharge to cover consumption',
          priority: 'low',
        }
      } else {
        decision = {
          action: 'idle',
          reason: 'Normal operation',
          priority: 'low',
        }
      }
    }
    
    hourlyPlan.push({
      hour,
      price,
      solarWatts,
      decision,
      expectedSoC: Math.round(currentSoC * 100) / 100,
    })
  }
  
  // Calculate cost savings
  const gridChargeCost = gridChargeHours.reduce((sum, hour) => {
    const price = pvpc.prices[hour]?.price || avgPrice
    return sum + price * (battery.maxChargeRateW / 1000)
  }, 0)
  
  // Savings vs charging at average price
  const avgChargeCost = gridChargeHours.length * avgPrice * (battery.maxChargeRateW / 1000)
  const savings = avgChargeCost - gridChargeCost
  
  // Generate recommendations
  const recommendations: string[] = []
  
  if (gridChargeHours.length > 0) {
    recommendations.push(
      `🔌 Charge from grid during hours ${gridChargeHours.join(', ')} (cheapest prices)`
    )
  }
  
  if (solar.totalWh > 5000) {
    recommendations.push(
      `☀️ Good solar day expected (${Math.round(solar.totalWh / 1000)}kWh) - prioritize self-consumption`
    )
  } else if (solar.totalWh < 2000) {
    recommendations.push(
      `🌥️ Low solar expected (${Math.round(solar.totalWh / 1000)}kWh) - plan for grid charging`
    )
  }
  
  const expensiveHours = pvpc.expensiveHours
  if (expensiveHours.length > 0) {
    recommendations.push(
      `⚠️ Avoid grid consumption during hours ${expensiveHours.join(', ')} (expensive)`
    )
  }
  
  if (savings > 0) {
    recommendations.push(
      `💰 Estimated savings today: €${savings.toFixed(2)} vs average prices`
    )
  }
  
  return {
    date: pvpc.date,
    hourlyPlan,
    gridChargeHours,
    gridChargeCost,
    solarChargeWh,
    gridExportWh,
    savings,
    recommendations,
  }
}

/**
 * Format plan as readable text
 */
export function formatPlan(plan: DailyPlan): string {
  const lines: string[] = [
    `📅 VoltAssistant Plan for ${plan.date}`,
    `${'='.repeat(40)}`,
    '',
    '📊 Recommendations:',
    ...plan.recommendations.map(r => `  ${r}`),
    '',
    '⏰ Hourly Schedule:',
  ]
  
  // Group consecutive hours with same action
  let currentAction = ''
  let startHour = 0
  
  for (let i = 0; i <= 24; i++) {
    const hour = plan.hourlyPlan[i]
    const action = hour?.decision.action || 'end'
    
    if (action !== currentAction) {
      if (currentAction && currentAction !== 'idle') {
        const endHour = i
        lines.push(`  ${startHour}:00-${endHour}:00 → ${formatAction(currentAction)}`)
      }
      currentAction = action
      startHour = i
    }
  }
  
  lines.push('')
  lines.push('💡 Summary:')
  lines.push(`  • Grid charge: ${plan.gridChargeHours.length}h (€${plan.gridChargeCost.toFixed(2)})`)
  lines.push(`  • Solar charge: ${Math.round(plan.solarChargeWh / 1000 * 10) / 10}kWh`)
  lines.push(`  • Grid export: ${Math.round(plan.gridExportWh / 1000 * 10) / 10}kWh`)
  lines.push(`  • Estimated savings: €${plan.savings.toFixed(2)}`)
  
  return lines.join('\n')
}

function formatAction(action: string): string {
  switch (action) {
    case 'charge_from_grid': return '🔌 Charge from grid'
    case 'charge_from_solar': return '☀️ Charge from solar'
    case 'discharge': return '🔋 Use battery'
    default: return action
  }
}

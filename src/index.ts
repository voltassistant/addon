#!/usr/bin/env node
/**
 * VoltAssistant - Smart Battery Charging Optimizer
 * 
 * Combines PVPC electricity prices with solar forecast to determine
 * the optimal battery charging strategy for home energy systems.
 */

import dotenv from 'dotenv'
import { getPVPCPrices, formatPrice } from './pvpc'
import { getSolarForecast } from './solar'
import { generateChargingPlan, formatPlan, BatteryConfig } from './optimizer'

dotenv.config()

async function main() {
  console.log('⚡ VoltAssistant - Smart Battery Optimizer')
  console.log('==========================================\n')
  
  const args = process.argv.slice(2)
  const dateArg = args.find(a => a.startsWith('--date='))
  const date = dateArg 
    ? new Date(dateArg.replace('--date=', ''))
    : new Date()
  
  const batteryArg = args.find(a => a.startsWith('--battery='))
  const batteryKwh = batteryArg 
    ? parseFloat(batteryArg.replace('--battery=', ''))
    : 10
  
  const battery: BatteryConfig = {
    capacityWh: batteryKwh * 1000,
    maxChargeRateW: 3000,
    minSoC: 0.1,
    maxSoC: 1.0,
    currentSoC: 0.5,
  }
  
  console.log(`📅 Date: ${date.toISOString().split('T')[0]}`)
  console.log(`🔋 Battery: ${batteryKwh}kWh\n`)
  
  try {
    // Fetch PVPC prices
    console.log('💶 Fetching electricity prices...')
    const pvpc = await getPVPCPrices(date)
    console.log(`   Average price: ${formatPrice(pvpc.averagePrice)}`)
    console.log(`   Cheapest hours: ${pvpc.cheapestHours.join(', ')}h`)
    console.log(`   Expensive hours: ${pvpc.expensiveHours.join(', ')}h\n`)
    
    // Fetch solar forecast
    console.log('☀️ Fetching solar forecast...')
    const solar = await getSolarForecast(date)
    console.log(`   Total expected: ${Math.round(solar.totalWh / 1000 * 10) / 10}kWh`)
    console.log(`   Peak: ${Math.round(solar.peakWatts)}W at ${solar.peakHour}:00\n`)
    
    // Generate optimal plan
    console.log('🧮 Generating optimal charging plan...\n')
    const plan = generateChargingPlan(pvpc, solar, battery)
    
    // Output the plan
    console.log(formatPlan(plan))
    
    // Detailed hourly view if requested
    if (args.includes('--detailed')) {
      console.log('\n📊 Detailed Hourly Plan:')
      console.log('-'.repeat(70))
      console.log('Hour | Price    | Solar  | SoC  | Action')
      console.log('-'.repeat(70))
      
      for (const hour of plan.hourlyPlan) {
        const priceStr = formatPrice(hour.price).padEnd(9)
        const solarStr = `${hour.solarWatts}W`.padEnd(6)
        const socStr = `${Math.round(hour.expectedSoC * 100)}%`.padEnd(4)
        const actionStr = hour.decision.action.replace(/_/g, ' ')
        
        console.log(
          `${hour.hour.toString().padStart(2, '0')}:00 | ${priceStr} | ${solarStr} | ${socStr} | ${actionStr}`
        )
      }
    }
    
    // JSON output if requested
    if (args.includes('--json')) {
      console.log('\n📄 JSON Output:')
      console.log(JSON.stringify(plan, null, 2))
    }
    
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// Show help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
VoltAssistant - Smart Battery Charging Optimizer

Usage: npx ts-node src/index.ts [options]

Options:
  --date=YYYY-MM-DD  Analyze a specific date (default: today)
  --battery=10       Battery capacity in kWh (default: 10)
  --detailed         Show detailed hourly breakdown
  --json             Output plan as JSON
  --help, -h         Show this help message

Environment Variables:
  ESIOS_TOKEN        ESIOS API token for real-time PVPC prices
  HA_URL             Home Assistant URL (for integration)
  HA_TOKEN           Home Assistant long-lived access token

Examples:
  npx ts-node src/index.ts
  npx ts-node src/index.ts --date=2024-01-15 --battery=15
  npx ts-node src/index.ts --detailed --json
`)
  process.exit(0)
}

main()

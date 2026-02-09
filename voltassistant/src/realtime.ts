/**
 * Real-time inverter status from Home Assistant
 * Combines live data with optimal charging plan
 */

import axios from 'axios'
import dotenv from 'dotenv'

dotenv.config()

const HA_URL = process.env.HA_URL || 'http://192.168.31.54:8123'
const HA_TOKEN = process.env.HA_TOKEN || ''

// Entity mappings for Deye/Solarman inverter
const ENTITIES = {
  // Battery
  batterySoc: 'sensor.predbat_battery_soc_2',
  batteryKwh: 'sensor.predbat_battery_kwh',
  batteryState: 'sensor.inverter_battery_state',
  batteryCapacity: 'sensor.inverter_battery_capacity',
  
  // Solar PV
  pv1Voltage: 'sensor.inverter_pv1_voltage',
  pv1Current: 'sensor.inverter_pv1_current',
  pv2Voltage: 'sensor.inverter_pv2_voltage',
  pv2Current: 'sensor.inverter_pv2_current',
  todayProduction: 'sensor.inverter_today_production',
  
  // Grid
  gridPower: 'sensor.inverter_grid_power',
  gridFrequency: 'sensor.inverter_grid_frequency',
  todayImport: 'sensor.inverter_today_energy_import',
  todayExport: 'sensor.inverter_today_energy_export',
  
  // Load
  loadPower: 'sensor.inverter_load_l1_power',
  todayConsumption: 'sensor.inverter_today_load_consumption',
  
  // Temperature
  inverterTemp: 'sensor.inverter_temperature',
  dcTemp: 'sensor.inverter_dc_temperature',
}

export interface InverterStatus {
  timestamp: string
  battery: {
    soc: number // %
    kwh: number
    capacity: number
    state: string // charging, discharging, idle
    power: number // W (calculated)
  }
  solar: {
    pv1Power: number // W
    pv2Power: number // W
    totalPower: number // W
    todayKwh: number
  }
  grid: {
    power: number // W (positive = import, negative = export)
    frequency: number // Hz
    todayImportKwh: number
    todayExportKwh: number
  }
  load: {
    power: number // W
    todayKwh: number
  }
  temperature: {
    inverter: number
    dc: number
  }
  health: {
    status: 'healthy' | 'warning' | 'error'
    issues: string[]
  }
}

async function getEntityState(entityId: string): Promise<{ state: string; unit: string | null }> {
  try {
    const response = await axios.get(`${HA_URL}/api/states/${entityId}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      timeout: 5000,
    })
    return {
      state: response.data.state,
      unit: response.data.attributes?.unit_of_measurement || null,
    }
  } catch (error) {
    return { state: 'unavailable', unit: null }
  }
}

function parseNumber(state: string): number {
  const num = parseFloat(state)
  return isNaN(num) ? 0 : num
}

export async function getInverterStatus(): Promise<InverterStatus> {
  // Fetch all entities in parallel
  const [
    batterySoc,
    batteryKwh,
    batteryState,
    batteryCapacity,
    pv1Voltage,
    pv1Current,
    pv2Voltage,
    pv2Current,
    todayProduction,
    gridPower,
    gridFrequency,
    todayImport,
    todayExport,
    loadPower,
    todayConsumption,
    inverterTemp,
    dcTemp,
  ] = await Promise.all([
    getEntityState(ENTITIES.batterySoc),
    getEntityState(ENTITIES.batteryKwh),
    getEntityState(ENTITIES.batteryState),
    getEntityState(ENTITIES.batteryCapacity),
    getEntityState(ENTITIES.pv1Voltage),
    getEntityState(ENTITIES.pv1Current),
    getEntityState(ENTITIES.pv2Voltage),
    getEntityState(ENTITIES.pv2Current),
    getEntityState(ENTITIES.todayProduction),
    getEntityState(ENTITIES.gridPower),
    getEntityState(ENTITIES.gridFrequency),
    getEntityState(ENTITIES.todayImport),
    getEntityState(ENTITIES.todayExport),
    getEntityState(ENTITIES.loadPower),
    getEntityState(ENTITIES.todayConsumption),
    getEntityState(ENTITIES.inverterTemp),
    getEntityState(ENTITIES.dcTemp),
  ])

  // Calculate PV power
  const pv1Power = parseNumber(pv1Voltage.state) * parseNumber(pv1Current.state)
  const pv2Power = parseNumber(pv2Voltage.state) * parseNumber(pv2Current.state)
  const totalSolarPower = pv1Power + pv2Power

  // Estimate battery power from energy flow
  const load = parseNumber(loadPower.state)
  const grid = parseNumber(gridPower.state)
  const solar = totalSolarPower
  // Battery power = Solar - Load - Grid (positive = charging)
  const batteryPower = solar - load - grid

  // Health check
  const issues: string[] = []
  const soc = parseNumber(batterySoc.state)
  const temp = parseNumber(inverterTemp.state)
  
  if (soc < 10) issues.push('Battery very low (<10%)')
  if (soc < 20) issues.push('Battery low - consider charging')
  if (temp > 50) issues.push('Inverter temperature high')
  if (gridFrequency.state === 'unavailable') issues.push('Grid connection issue')
  
  const healthStatus = issues.some(i => i.includes('very') || i.includes('high')) 
    ? 'warning' 
    : issues.length > 0 ? 'warning' : 'healthy'

  return {
    timestamp: new Date().toISOString(),
    battery: {
      soc: parseNumber(batterySoc.state),
      kwh: parseNumber(batteryKwh.state),
      capacity: parseNumber(batteryCapacity.state),
      state: batteryState.state,
      power: Math.round(batteryPower),
    },
    solar: {
      pv1Power: Math.round(pv1Power),
      pv2Power: Math.round(pv2Power),
      totalPower: Math.round(totalSolarPower),
      todayKwh: parseNumber(todayProduction.state),
    },
    grid: {
      power: parseNumber(gridPower.state),
      frequency: parseNumber(gridFrequency.state),
      todayImportKwh: parseNumber(todayImport.state),
      todayExportKwh: parseNumber(todayExport.state),
    },
    load: {
      power: parseNumber(loadPower.state),
      todayKwh: parseNumber(todayConsumption.state),
    },
    temperature: {
      inverter: parseNumber(inverterTemp.state),
      dc: parseNumber(dcTemp.state),
    },
    health: {
      status: healthStatus,
      issues,
    },
  }
}

// CLI mode
if (require.main === module) {
  getInverterStatus()
    .then(status => {
      console.log('⚡ Inverter Status')
      console.log('='.repeat(40))
      console.log(`\n🔋 Battery: ${status.battery.soc}% (${status.battery.kwh}/${status.battery.capacity} kWh)`)
      console.log(`   State: ${status.battery.state}, Power: ${status.battery.power}W`)
      console.log(`\n☀️ Solar: ${status.solar.totalPower}W (PV1: ${status.solar.pv1Power}W, PV2: ${status.solar.pv2Power}W)`)
      console.log(`   Today: ${status.solar.todayKwh} kWh`)
      console.log(`\n🔌 Grid: ${status.grid.power}W @ ${status.grid.frequency}Hz`)
      console.log(`   Import: ${status.grid.todayImportKwh} kWh, Export: ${status.grid.todayExportKwh} kWh`)
      console.log(`\n💡 Load: ${status.load.power}W (Today: ${status.load.todayKwh} kWh)`)
      console.log(`\n🌡️ Temperature: Inverter ${status.temperature.inverter}°C, DC ${status.temperature.dc}°C`)
      console.log(`\n❤️ Health: ${status.health.status}`)
      if (status.health.issues.length > 0) {
        status.health.issues.forEach(i => console.log(`   ⚠️ ${i}`))
      }
    })
    .catch(console.error)
}

/**
 * Solar Forecast API
 * Uses forecast.solar (free) or Solcast (paid) for solar production predictions
 */

import axios from 'axios'

export interface SolarForecast {
  hour: number
  watts: number // Expected production in watts
  datetime: Date
}

export interface SolarDay {
  date: string
  forecasts: SolarForecast[]
  totalWh: number
  peakHour: number
  peakWatts: number
}

export interface SolarSystemConfig {
  latitude: number
  longitude: number
  declination: number // Panel tilt (degrees)
  azimuth: number // Panel orientation (-180 to 180, 0=south)
  kwp: number // System capacity in kWp
}

// Default config for Gijón, Spain (typical rooftop)
const DEFAULT_CONFIG: SolarSystemConfig = {
  latitude: 43.5322,
  longitude: -5.6611,
  declination: 35, // Optimal for northern Spain
  azimuth: 0, // South facing
  kwp: 6, // 6kW system (Deye SUN-6K-EU)
}

/**
 * Fetch solar forecast from forecast.solar (free API)
 */
export async function getSolarForecast(
  date: Date = new Date(),
  config: SolarSystemConfig = DEFAULT_CONFIG
): Promise<SolarDay> {
  const dateStr = date.toISOString().split('T')[0]
  
  try {
    // forecast.solar API (free tier)
    const url = `https://api.forecast.solar/estimate/${config.latitude}/${config.longitude}/${config.declination}/${config.azimuth}/${config.kwp}`
    
    const response = await axios.get(url)
    const data = response.data
    
    if (data.result?.watts) {
      return parseForecastSolarResponse(dateStr, data.result.watts)
    }
    
    // If API fails, generate estimate based on location and time of year
    return generateEstimate(date, config)
  } catch (error) {
    console.error('Error fetching solar forecast:', error)
    // Generate estimate if API fails
    return generateEstimate(date, config)
  }
}

function parseForecastSolarResponse(date: string, watts: Record<string, number>): SolarDay {
  const forecasts: SolarForecast[] = []
  let totalWh = 0
  let peakHour = 0
  let peakWatts = 0
  
  // Group by hour (API returns 15-min intervals)
  const hourlyWatts: Map<number, number[]> = new Map()
  
  for (const [datetime, value] of Object.entries(watts)) {
    if (!datetime.startsWith(date)) continue
    
    const hour = new Date(datetime).getHours()
    if (!hourlyWatts.has(hour)) {
      hourlyWatts.set(hour, [])
    }
    hourlyWatts.get(hour)!.push(value)
  }
  
  // Average watts per hour
  for (const [hour, values] of hourlyWatts.entries()) {
    const avgWatts = values.reduce((a, b) => a + b, 0) / values.length
    
    forecasts.push({
      hour,
      watts: Math.round(avgWatts),
      datetime: new Date(`${date}T${hour.toString().padStart(2, '0')}:00:00`),
    })
    
    totalWh += avgWatts // Wh = W * 1h
    
    if (avgWatts > peakWatts) {
      peakWatts = avgWatts
      peakHour = hour
    }
  }
  
  forecasts.sort((a, b) => a.hour - b.hour)
  
  return {
    date,
    forecasts,
    totalWh: Math.round(totalWh),
    peakHour,
    peakWatts: Math.round(peakWatts),
  }
}

/**
 * Generate solar estimate based on location and season
 */
function generateEstimate(date: Date, config: SolarSystemConfig): SolarDay {
  const dateStr = date.toISOString().split('T')[0]
  const month = date.getMonth() + 1 // 1-12
  
  // Seasonal factors for northern Spain
  const seasonalFactor: Record<number, number> = {
    1: 0.35, 2: 0.45, 3: 0.60, 4: 0.75, 5: 0.85, 6: 0.95,
    7: 1.00, 8: 0.95, 9: 0.80, 10: 0.60, 11: 0.40, 12: 0.30,
  }
  
  const factor = seasonalFactor[month] || 0.6
  const maxOutput = config.kwp * 1000 * factor // Max watts
  
  // Generate hourly production curve
  const forecasts: SolarForecast[] = []
  let totalWh = 0
  let peakWatts = 0
  let peakHour = 12
  
  for (let hour = 0; hour < 24; hour++) {
    let watts = 0
    
    // Production curve (sunrise ~7am, sunset ~8pm in summer, adjust by season)
    const sunriseHour = 6 + (1 - factor) * 2
    const sunsetHour = 21 - (1 - factor) * 3
    
    if (hour >= sunriseHour && hour <= sunsetHour) {
      // Bell curve centered at solar noon (~14:00 in Spain due to timezone)
      const solarNoon = 14
      const hourFromNoon = Math.abs(hour - solarNoon)
      const dayLength = sunsetHour - sunriseHour
      
      // Cosine-based curve
      const position = (hour - sunriseHour) / dayLength * Math.PI
      watts = Math.sin(position) * maxOutput
      
      // Add some cloud randomness
      watts *= 0.8 + Math.random() * 0.2
    }
    
    watts = Math.max(0, Math.round(watts))
    
    forecasts.push({
      hour,
      watts,
      datetime: new Date(`${dateStr}T${hour.toString().padStart(2, '0')}:00:00`),
    })
    
    totalWh += watts
    
    if (watts > peakWatts) {
      peakWatts = watts
      peakHour = hour
    }
  }
  
  return {
    date: dateStr,
    forecasts,
    totalWh: Math.round(totalWh),
    peakHour,
    peakWatts: Math.round(peakWatts),
  }
}

/**
 * Calculate expected battery charge from solar
 * @param forecast Solar forecast for the day
 * @param batteryCapacity Battery capacity in Wh
 * @param currentCharge Current battery charge in Wh
 * @param consumptionPattern Hourly consumption in Wh (24 values)
 */
export function calculateBatteryCharge(
  forecast: SolarDay,
  batteryCapacity: number,
  currentCharge: number,
  consumptionPattern: number[]
): {
  hourlyCharge: number[]
  finalCharge: number
  excessToGrid: number
  gridConsumption: number
} {
  const hourlyCharge: number[] = []
  let charge = currentCharge
  let excessToGrid = 0
  let gridConsumption = 0
  
  for (let hour = 0; hour < 24; hour++) {
    const solar = forecast.forecasts[hour]?.watts || 0
    const consumption = consumptionPattern[hour] || 300 // Default 300Wh/hour
    
    const netProduction = solar - consumption
    
    if (netProduction > 0) {
      // Excess production - charge battery
      const chargeAmount = Math.min(netProduction, batteryCapacity - charge)
      charge += chargeAmount
      excessToGrid += netProduction - chargeAmount
    } else {
      // Deficit - use battery
      const dischargeAmount = Math.min(-netProduction, charge)
      charge -= dischargeAmount
      gridConsumption += -netProduction - dischargeAmount
    }
    
    hourlyCharge.push(Math.round(charge))
  }
  
  return {
    hourlyCharge,
    finalCharge: Math.round(charge),
    excessToGrid: Math.round(excessToGrid),
    gridConsumption: Math.round(gridConsumption),
  }
}

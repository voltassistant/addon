/**
 * Price and Solar History
 * Fetch historical data for analysis and visualization
 */

import { getPVPCPrices, PVPCDay } from './pvpc'
import { getSolarForecast, SolarDay } from './solar'

export interface DayHistory {
  date: string
  prices: {
    average: number
    min: number
    max: number
    cheapestHours: number[]
    expensiveHours: number[]
  }
  solar: {
    totalKwh: number
    peakWatts: number
    peakHour: number
  }
}

export interface WeekHistory {
  startDate: string
  endDate: string
  days: DayHistory[]
  summary: {
    avgPrice: number
    totalSolarKwh: number
    bestDay: string
    worstDay: string
  }
}

/**
 * Get history for the past N days
 */
export async function getDayHistory(daysBack: number = 7): Promise<DayHistory[]> {
  const history: DayHistory[] = []
  const today = new Date()
  
  for (let i = 0; i < daysBack; i++) {
    const date = new Date(today)
    date.setDate(date.getDate() - i)
    
    try {
      const [pvpc, solar] = await Promise.all([
        getPVPCPrices(date),
        getSolarForecast(date),
      ])
      
      const prices = pvpc.prices.map(p => p.price)
      
      history.push({
        date: date.toISOString().split('T')[0],
        prices: {
          average: pvpc.averagePrice,
          min: Math.min(...prices),
          max: Math.max(...prices),
          cheapestHours: pvpc.cheapestHours,
          expensiveHours: pvpc.expensiveHours,
        },
        solar: {
          totalKwh: Math.round(solar.totalWh / 100) / 10,
          peakWatts: solar.peakWatts,
          peakHour: solar.peakHour,
        },
      })
    } catch (error) {
      console.error(`Failed to get history for ${date.toISOString().split('T')[0]}:`, error)
    }
  }
  
  return history
}

/**
 * Get weekly summary
 */
export async function getWeekHistory(): Promise<WeekHistory> {
  const days = await getDayHistory(7)
  
  if (days.length === 0) {
    throw new Error('No history data available')
  }
  
  const avgPrice = days.reduce((sum, d) => sum + d.prices.average, 0) / days.length
  const totalSolarKwh = days.reduce((sum, d) => sum + d.solar.totalKwh, 0)
  
  // Find best (cheapest) and worst (most expensive) days
  const sortedByPrice = [...days].sort((a, b) => a.prices.average - b.prices.average)
  const bestDay = sortedByPrice[0]?.date || ''
  const worstDay = sortedByPrice[sortedByPrice.length - 1]?.date || ''
  
  return {
    startDate: days[days.length - 1]?.date || '',
    endDate: days[0]?.date || '',
    days: days.reverse(), // Oldest first
    summary: {
      avgPrice: Math.round(avgPrice * 10000) / 10000,
      totalSolarKwh: Math.round(totalSolarKwh * 10) / 10,
      bestDay,
      worstDay,
    },
  }
}

/**
 * Calculate optimal charging windows across multiple days
 */
export function findBestChargingWindows(history: DayHistory[]): {
  window: { day: string; hour: number; price: number }[]
  avgPrice: number
} {
  // Flatten all hours with their prices
  const allHours: { day: string; hour: number; price: number }[] = []
  
  for (const day of history) {
    // Estimate prices for each hour based on average and position
    const cheapHours = new Set(day.prices.cheapestHours)
    
    for (let hour = 0; hour < 24; hour++) {
      let estimatedPrice = day.prices.average
      if (cheapHours.has(hour)) {
        estimatedPrice = day.prices.min + (day.prices.average - day.prices.min) * 0.3
      } else if (day.prices.expensiveHours.includes(hour)) {
        estimatedPrice = day.prices.average + (day.prices.max - day.prices.average) * 0.7
      }
      
      allHours.push({
        day: day.date,
        hour,
        price: estimatedPrice,
      })
    }
  }
  
  // Sort by price and take the cheapest 24 hours (for a full day's charge)
  const sorted = allHours.sort((a, b) => a.price - b.price)
  const best24 = sorted.slice(0, 24)
  
  const avgPrice = best24.reduce((sum, h) => sum + h.price, 0) / best24.length
  
  // Group by day for readability
  const window = best24.sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day)
    return a.hour - b.hour
  })
  
  return {
    window,
    avgPrice: Math.round(avgPrice * 10000) / 10000,
  }
}

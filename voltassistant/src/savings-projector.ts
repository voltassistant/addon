/**
 * Savings Projector
 * Calculate projected savings based on historical data and optimization strategies
 */

import { PVPCDay, PVPCPrice } from './pvpc';
import { SolarDay, SolarForecast } from './solar';
import { BatteryConfig, DailyPlan } from './optimizer';

export interface SavingsProjection {
  daily: DailySavings;
  weekly: WeeklySavings;
  monthly: MonthlySavings;
  yearly: YearlySavings;
  breakeven: BreakevenAnalysis;
}

export interface DailySavings {
  date: string;
  withOptimization: number;
  withoutOptimization: number;
  savings: number;
  savingsPercent: number;
  gridImportKwh: number;
  gridExportKwh: number;
  solarUsedKwh: number;
  peakAvoidedKwh: number;
}

export interface WeeklySavings {
  weekStart: string;
  weekEnd: string;
  totalSavings: number;
  avgDailySavings: number;
  bestDay: { date: string; savings: number };
  worstDay: { date: string; savings: number };
  totalSolarUsed: number;
  totalGridImport: number;
}

export interface MonthlySavings {
  month: string;
  year: number;
  totalSavings: number;
  projectedAnnualSavings: number;
  avgDailySavings: number;
  daysTracked: number;
  co2Avoided: number; // kg
  comparison: {
    vsLastMonth: number;
    vsSameMonthLastYear: number | null;
  };
}

export interface YearlySavings {
  year: number;
  totalSavings: number;
  avgMonthlySavings: number;
  bestMonth: { month: string; savings: number };
  worstMonth: { month: string; savings: number };
  totalSolarGenerated: number;
  selfConsumptionRate: number;
  co2Avoided: number;
}

export interface BreakevenAnalysis {
  batteryInvestment: number;
  monthlySavings: number;
  monthsToBreakeven: number;
  breakevenDate: string;
  roi5Year: number;
  roi10Year: number;
}

export interface ConsumptionProfile {
  hourly: number[]; // 24 hours of typical consumption in Wh
  weekdayModifier: number; // multiplier for weekdays
  weekendModifier: number; // multiplier for weekends
  seasonalModifiers: {
    winter: number;
    spring: number;
    summer: number;
    autumn: number;
  };
}

// Default Spanish household consumption profile
const DEFAULT_CONSUMPTION: ConsumptionProfile = {
  hourly: [
    200, 150, 100, 100, 100, 150, // 00:00 - 05:00
    300, 500, 600, 400, 350, 400, // 06:00 - 11:00
    600, 700, 600, 400, 350, 400, // 12:00 - 17:00
    500, 700, 900, 1000, 800, 500 // 18:00 - 23:00
  ],
  weekdayModifier: 1.0,
  weekendModifier: 1.2,
  seasonalModifiers: {
    winter: 1.3,
    spring: 0.9,
    summer: 1.1,
    autumn: 1.0
  }
};

// CO2 emissions factor for Spanish grid (kg CO2 per kWh)
const CO2_FACTOR_SPAIN = 0.2; // Average, varies with renewable mix

/**
 * Calculate daily savings from optimization
 */
export function calculateDailySavings(
  plan: DailyPlan,
  pvpc: PVPCDay,
  consumption: ConsumptionProfile = DEFAULT_CONSUMPTION,
  isWeekend: boolean = false
): DailySavings {
  const modifier = isWeekend ? consumption.weekendModifier : consumption.weekdayModifier;
  
  let withOptimization = 0;
  let withoutOptimization = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;
  let solarUsedKwh = 0;
  let peakAvoidedKwh = 0;

  for (let hour = 0; hour < 24; hour++) {
    const hourlyConsumption = consumption.hourly[hour] * modifier;
    const price = pvpc.prices[hour]?.price || 0.12;
    const hourPlan = plan.hourlyPlan[hour];
    const solarWatts = hourPlan?.solarWatts || 0;

    // Without optimization: all consumption from grid at current price
    withoutOptimization += (hourlyConsumption / 1000) * price;

    // With optimization
    if (solarWatts > 0) {
      // Use solar first
      const solarUsed = Math.min(solarWatts, hourlyConsumption);
      solarUsedKwh += solarUsed / 1000;
      
      const remaining = hourlyConsumption - solarUsed;
      if (remaining > 0) {
        // Use battery or grid for remaining
        if (hourPlan?.decision.action === 'discharge') {
          // Using battery (previously charged at cheaper rate)
          withOptimization += (remaining / 1000) * (plan.gridChargeCost / plan.gridChargeHours.length || 0.08);
        } else {
          gridImportKwh += remaining / 1000;
          withOptimization += (remaining / 1000) * price;
        }
      }
      
      // Export excess solar
      const excess = solarWatts - hourlyConsumption;
      if (excess > 0) {
        gridExportKwh += excess / 1000;
        // Compensation for exports (simplified)
        withOptimization -= (excess / 1000) * 0.05;
      }
    } else {
      // No solar - use battery or grid
      if (hourPlan?.decision.action === 'discharge' && pvpc.expensiveHours.includes(hour)) {
        // Discharging during expensive hours
        peakAvoidedKwh += hourlyConsumption / 1000;
        withOptimization += (hourlyConsumption / 1000) * (plan.gridChargeCost / plan.gridChargeHours.length || 0.08);
      } else {
        gridImportKwh += hourlyConsumption / 1000;
        withOptimization += (hourlyConsumption / 1000) * price;
      }
    }
  }

  const savings = withoutOptimization - withOptimization;
  const savingsPercent = withoutOptimization > 0 ? (savings / withoutOptimization) * 100 : 0;

  return {
    date: plan.date,
    withOptimization,
    withoutOptimization,
    savings,
    savingsPercent,
    gridImportKwh,
    gridExportKwh,
    solarUsedKwh,
    peakAvoidedKwh
  };
}

/**
 * Aggregate daily savings into weekly summary
 */
export function calculateWeeklySavings(dailySavings: DailySavings[]): WeeklySavings {
  if (dailySavings.length === 0) {
    return {
      weekStart: '',
      weekEnd: '',
      totalSavings: 0,
      avgDailySavings: 0,
      bestDay: { date: '', savings: 0 },
      worstDay: { date: '', savings: 0 },
      totalSolarUsed: 0,
      totalGridImport: 0
    };
  }

  const sorted = [...dailySavings].sort((a, b) => a.savings - b.savings);
  const totalSavings = dailySavings.reduce((sum, d) => sum + d.savings, 0);

  return {
    weekStart: dailySavings[0].date,
    weekEnd: dailySavings[dailySavings.length - 1].date,
    totalSavings,
    avgDailySavings: totalSavings / dailySavings.length,
    bestDay: { date: sorted[sorted.length - 1].date, savings: sorted[sorted.length - 1].savings },
    worstDay: { date: sorted[0].date, savings: sorted[0].savings },
    totalSolarUsed: dailySavings.reduce((sum, d) => sum + d.solarUsedKwh, 0),
    totalGridImport: dailySavings.reduce((sum, d) => sum + d.gridImportKwh, 0)
  };
}

/**
 * Calculate monthly savings with projections
 */
export function calculateMonthlySavings(
  dailySavings: DailySavings[],
  month: string,
  year: number,
  lastMonthSavings?: number,
  sameMonthLastYearSavings?: number
): MonthlySavings {
  const totalSavings = dailySavings.reduce((sum, d) => sum + d.savings, 0);
  const daysTracked = dailySavings.length;
  const avgDailySavings = daysTracked > 0 ? totalSavings / daysTracked : 0;
  
  // Project to full month (30 days) and then to full year
  const daysInMonth = 30;
  const projectedMonthlySavings = avgDailySavings * daysInMonth;
  const projectedAnnualSavings = projectedMonthlySavings * 12;

  // CO2 avoided (based on solar used and peak avoided)
  const totalSolarKwh = dailySavings.reduce((sum, d) => sum + d.solarUsedKwh, 0);
  const totalPeakAvoided = dailySavings.reduce((sum, d) => sum + d.peakAvoidedKwh, 0);
  const co2Avoided = (totalSolarKwh + totalPeakAvoided * 0.5) * CO2_FACTOR_SPAIN;

  return {
    month,
    year,
    totalSavings,
    projectedAnnualSavings,
    avgDailySavings,
    daysTracked,
    co2Avoided,
    comparison: {
      vsLastMonth: lastMonthSavings ? ((totalSavings - lastMonthSavings) / lastMonthSavings) * 100 : 0,
      vsSameMonthLastYear: sameMonthLastYearSavings 
        ? ((totalSavings - sameMonthLastYearSavings) / sameMonthLastYearSavings) * 100 
        : null
    }
  };
}

/**
 * Calculate yearly savings summary
 */
export function calculateYearlySavings(
  monthlySavings: MonthlySavings[],
  year: number
): YearlySavings {
  const totalSavings = monthlySavings.reduce((sum, m) => sum + m.totalSavings, 0);
  const sorted = [...monthlySavings].sort((a, b) => a.totalSavings - b.totalSavings);
  const co2Avoided = monthlySavings.reduce((sum, m) => sum + m.co2Avoided, 0);

  return {
    year,
    totalSavings,
    avgMonthlySavings: monthlySavings.length > 0 ? totalSavings / monthlySavings.length : 0,
    bestMonth: sorted.length > 0 
      ? { month: sorted[sorted.length - 1].month, savings: sorted[sorted.length - 1].totalSavings }
      : { month: '', savings: 0 },
    worstMonth: sorted.length > 0
      ? { month: sorted[0].month, savings: sorted[0].totalSavings }
      : { month: '', savings: 0 },
    totalSolarGenerated: 0, // Would need solar data
    selfConsumptionRate: 0, // Would need detailed data
    co2Avoided
  };
}

/**
 * Calculate breakeven analysis for battery investment
 */
export function calculateBreakeven(
  batteryInvestment: number,
  avgMonthlySavings: number,
  electricityPriceInflation: number = 0.05 // 5% annual increase
): BreakevenAnalysis {
  // Simple breakeven (without inflation)
  const simpleMonthsToBreakeven = avgMonthlySavings > 0 
    ? batteryInvestment / avgMonthlySavings 
    : Infinity;

  // Calculate with price inflation
  let cumulativeSavings = 0;
  let monthsToBreakeven = 0;
  let currentMonthlySavings = avgMonthlySavings;

  while (cumulativeSavings < batteryInvestment && monthsToBreakeven < 300) { // Max 25 years
    cumulativeSavings += currentMonthlySavings;
    monthsToBreakeven++;
    
    // Apply monthly inflation (annual / 12)
    if (monthsToBreakeven % 12 === 0) {
      currentMonthlySavings *= (1 + electricityPriceInflation);
    }
  }

  // Calculate breakeven date
  const now = new Date();
  const breakevenDate = new Date(now.setMonth(now.getMonth() + monthsToBreakeven));

  // Calculate ROI
  const calculateROI = (years: number): number => {
    let totalSavings = 0;
    let monthlySavings = avgMonthlySavings;
    
    for (let month = 0; month < years * 12; month++) {
      totalSavings += monthlySavings;
      if (month % 12 === 11) {
        monthlySavings *= (1 + electricityPriceInflation);
      }
    }
    
    return ((totalSavings - batteryInvestment) / batteryInvestment) * 100;
  };

  return {
    batteryInvestment,
    monthlySavings: avgMonthlySavings,
    monthsToBreakeven,
    breakevenDate: breakevenDate.toISOString().split('T')[0],
    roi5Year: calculateROI(5),
    roi10Year: calculateROI(10)
  };
}

/**
 * Generate full savings projection
 */
export function generateSavingsProjection(
  recentPlans: DailyPlan[],
  pvpcHistory: PVPCDay[],
  batteryInvestment: number,
  consumption: ConsumptionProfile = DEFAULT_CONSUMPTION
): SavingsProjection {
  // Calculate daily savings for each plan
  const dailySavingsArray = recentPlans.map((plan, i) => {
    const pvpc = pvpcHistory[i] || pvpcHistory[0];
    const date = new Date(plan.date);
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    return calculateDailySavings(plan, pvpc, consumption, isWeekend);
  });

  // Get most recent day
  const daily = dailySavingsArray[dailySavingsArray.length - 1] || {
    date: new Date().toISOString().split('T')[0],
    withOptimization: 0,
    withoutOptimization: 0,
    savings: 0,
    savingsPercent: 0,
    gridImportKwh: 0,
    gridExportKwh: 0,
    solarUsedKwh: 0,
    peakAvoidedKwh: 0
  };

  // Calculate weekly (last 7 days)
  const weeklyData = dailySavingsArray.slice(-7);
  const weekly = calculateWeeklySavings(weeklyData);

  // Calculate monthly (last 30 days)
  const monthlyData = dailySavingsArray.slice(-30);
  const now = new Date();
  const monthly = calculateMonthlySavings(
    monthlyData,
    now.toLocaleString('default', { month: 'long' }),
    now.getFullYear()
  );

  // Calculate yearly projection
  const yearly = calculateYearlySavings([monthly], now.getFullYear());

  // Calculate breakeven
  const breakeven = calculateBreakeven(batteryInvestment, monthly.avgDailySavings * 30);

  return {
    daily,
    weekly,
    monthly,
    yearly,
    breakeven
  };
}

/**
 * Format savings for display
 */
export function formatSavings(amount: number, currency: string = '€'): string {
  return `${amount >= 0 ? '' : '-'}${currency}${Math.abs(amount).toFixed(2)}`;
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function formatCO2(kg: number): string {
  if (kg >= 1000) {
    return `${(kg / 1000).toFixed(1)} t CO₂`;
  }
  return `${kg.toFixed(1)} kg CO₂`;
}

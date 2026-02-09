/**
 * Home Assistant Long-Lived Statistics
 * 
 * Features:
 * - Integration with HA statistics API
 * - Long-term data storage (hourly aggregation)
 * - Custom statistics entities
 * - Historical data queries
 * - Energy-specific statistics
 */

// ============================================================================
// Types
// ============================================================================

export interface StatisticMetadata {
  statistic_id: string;
  source: string;
  name: string;
  unit_of_measurement: string;
  has_mean: boolean;
  has_sum: boolean;
}

export interface StatisticValue {
  start: string; // ISO timestamp
  end: string;
  mean?: number;
  min?: number;
  max?: number;
  sum?: number;
  state?: number;
  change?: number;
}

export interface StatisticEntry {
  metadata: StatisticMetadata;
  statistics: StatisticValue[];
}

export interface StatisticInsert {
  start: Date;
  mean?: number;
  min?: number;
  max?: number;
  sum?: number;
  state?: number;
}

// ============================================================================
// Statistics Manager
// ============================================================================

export class HAStatisticsManager {
  private haBaseUrl: string;
  private haToken: string;
  private statisticsQueue: Map<string, StatisticInsert[]> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly FLUSH_INTERVAL_MS = 60000; // 1 minute

  constructor(options: { haBaseUrl?: string; haToken?: string } = {}) {
    this.haBaseUrl = options.haBaseUrl || process.env.HA_BASE_URL || 'http://supervisor/core';
    this.haToken = options.haToken || process.env.SUPERVISOR_TOKEN || '';
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  start(): void {
    if (this.flushInterval) return;

    this.flushInterval = setInterval(() => {
      this.flush();
    }, this.FLUSH_INTERVAL_MS);

    console.log('[HAStatistics] Started statistics manager');
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush(); // Flush remaining data
    console.log('[HAStatistics] Stopped statistics manager');
  }

  // ==========================================================================
  // Statistics Registration
  // ==========================================================================

  async registerStatistic(metadata: StatisticMetadata): Promise<void> {
    const url = `${this.haBaseUrl}/api/statistics/meta`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.haToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
      });

      if (!response.ok) {
        throw new Error(`Failed to register statistic: ${response.status}`);
      }

      console.log(`[HAStatistics] Registered: ${metadata.statistic_id}`);
    } catch (error) {
      console.error('[HAStatistics] Registration error:', error);
    }
  }

  // ==========================================================================
  // VoltAssistant Statistics
  // ==========================================================================

  readonly STATISTICS = {
    // Energy statistics
    solar_production: {
      statistic_id: 'sensor.voltassistant_solar_production',
      source: 'voltassistant',
      name: 'VoltAssistant Solar Production',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },
    grid_import: {
      statistic_id: 'sensor.voltassistant_grid_import',
      source: 'voltassistant',
      name: 'VoltAssistant Grid Import',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },
    grid_export: {
      statistic_id: 'sensor.voltassistant_grid_export',
      source: 'voltassistant',
      name: 'VoltAssistant Grid Export',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },
    battery_charge: {
      statistic_id: 'sensor.voltassistant_battery_charge',
      source: 'voltassistant',
      name: 'VoltAssistant Battery Charge',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },
    battery_discharge: {
      statistic_id: 'sensor.voltassistant_battery_discharge',
      source: 'voltassistant',
      name: 'VoltAssistant Battery Discharge',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },
    consumption: {
      statistic_id: 'sensor.voltassistant_consumption',
      source: 'voltassistant',
      name: 'VoltAssistant Consumption',
      unit_of_measurement: 'kWh',
      has_mean: false,
      has_sum: true,
    },

    // Financial statistics
    savings: {
      statistic_id: 'sensor.voltassistant_savings',
      source: 'voltassistant',
      name: 'VoltAssistant Savings',
      unit_of_measurement: '€',
      has_mean: false,
      has_sum: true,
    },
    electricity_cost: {
      statistic_id: 'sensor.voltassistant_electricity_cost',
      source: 'voltassistant',
      name: 'VoltAssistant Electricity Cost',
      unit_of_measurement: '€',
      has_mean: false,
      has_sum: true,
    },

    // Optimization statistics
    self_consumption_ratio: {
      statistic_id: 'sensor.voltassistant_self_consumption_ratio',
      source: 'voltassistant',
      name: 'VoltAssistant Self Consumption Ratio',
      unit_of_measurement: '%',
      has_mean: true,
      has_sum: false,
    },
    optimization_decisions: {
      statistic_id: 'sensor.voltassistant_optimization_decisions',
      source: 'voltassistant',
      name: 'VoltAssistant Optimization Decisions',
      unit_of_measurement: '',
      has_mean: false,
      has_sum: true,
    },
  } as const;

  async registerAllStatistics(): Promise<void> {
    for (const stat of Object.values(this.STATISTICS)) {
      await this.registerStatistic(stat as StatisticMetadata);
    }
  }

  // ==========================================================================
  // Record Statistics
  // ==========================================================================

  recordStatistic(
    statisticId: string,
    value: StatisticInsert
  ): void {
    if (!this.statisticsQueue.has(statisticId)) {
      this.statisticsQueue.set(statisticId, []);
    }
    this.statisticsQueue.get(statisticId)!.push(value);
  }

  recordEnergy(data: {
    solarProduction?: number;
    gridImport?: number;
    gridExport?: number;
    batteryCharge?: number;
    batteryDischarge?: number;
    consumption?: number;
  }): void {
    const now = new Date();

    if (data.solarProduction !== undefined) {
      this.recordStatistic(this.STATISTICS.solar_production.statistic_id, {
        start: now,
        sum: data.solarProduction,
      });
    }

    if (data.gridImport !== undefined) {
      this.recordStatistic(this.STATISTICS.grid_import.statistic_id, {
        start: now,
        sum: data.gridImport,
      });
    }

    if (data.gridExport !== undefined) {
      this.recordStatistic(this.STATISTICS.grid_export.statistic_id, {
        start: now,
        sum: data.gridExport,
      });
    }

    if (data.batteryCharge !== undefined) {
      this.recordStatistic(this.STATISTICS.battery_charge.statistic_id, {
        start: now,
        sum: data.batteryCharge,
      });
    }

    if (data.batteryDischarge !== undefined) {
      this.recordStatistic(this.STATISTICS.battery_discharge.statistic_id, {
        start: now,
        sum: data.batteryDischarge,
      });
    }

    if (data.consumption !== undefined) {
      this.recordStatistic(this.STATISTICS.consumption.statistic_id, {
        start: now,
        sum: data.consumption,
      });
    }
  }

  recordFinancial(data: {
    savings?: number;
    cost?: number;
  }): void {
    const now = new Date();

    if (data.savings !== undefined) {
      this.recordStatistic(this.STATISTICS.savings.statistic_id, {
        start: now,
        sum: data.savings,
      });
    }

    if (data.cost !== undefined) {
      this.recordStatistic(this.STATISTICS.electricity_cost.statistic_id, {
        start: now,
        sum: data.cost,
      });
    }
  }

  recordOptimization(data: {
    selfConsumptionRatio?: number;
    decisionsCount?: number;
  }): void {
    const now = new Date();

    if (data.selfConsumptionRatio !== undefined) {
      this.recordStatistic(this.STATISTICS.self_consumption_ratio.statistic_id, {
        start: now,
        mean: data.selfConsumptionRatio,
      });
    }

    if (data.decisionsCount !== undefined) {
      this.recordStatistic(this.STATISTICS.optimization_decisions.statistic_id, {
        start: now,
        sum: data.decisionsCount,
      });
    }
  }

  // ==========================================================================
  // Flush to Home Assistant
  // ==========================================================================

  async flush(): Promise<void> {
    if (this.statisticsQueue.size === 0) return;

    const entries = Array.from(this.statisticsQueue.entries());
    this.statisticsQueue.clear();

    for (const [statisticId, values] of entries) {
      await this.insertStatistics(statisticId, values);
    }
  }

  private async insertStatistics(
    statisticId: string,
    values: StatisticInsert[]
  ): Promise<void> {
    const url = `${this.haBaseUrl}/api/statistics`;

    // Aggregate by hour
    const hourlyData = this.aggregateByHour(values);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.haToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          statistic_id: statisticId,
          statistics: hourlyData,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to insert statistics: ${response.status}`);
      }

      console.log(`[HAStatistics] Flushed ${hourlyData.length} entries for ${statisticId}`);
    } catch (error) {
      console.error(`[HAStatistics] Flush error for ${statisticId}:`, error);
      // Re-queue the values
      for (const value of values) {
        this.recordStatistic(statisticId, value);
      }
    }
  }

  private aggregateByHour(values: StatisticInsert[]): StatisticValue[] {
    const hourlyBuckets: Map<string, StatisticInsert[]> = new Map();

    for (const value of values) {
      const hour = new Date(value.start);
      hour.setMinutes(0, 0, 0);
      const hourKey = hour.toISOString();

      if (!hourlyBuckets.has(hourKey)) {
        hourlyBuckets.set(hourKey, []);
      }
      hourlyBuckets.get(hourKey)!.push(value);
    }

    const result: StatisticValue[] = [];

    for (const [hourKey, hourValues] of hourlyBuckets) {
      const start = new Date(hourKey);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);

      const aggregated: StatisticValue = {
        start: start.toISOString(),
        end: end.toISOString(),
      };

      // Aggregate mean values
      const meanValues = hourValues.filter(v => v.mean !== undefined).map(v => v.mean!);
      if (meanValues.length > 0) {
        aggregated.mean = meanValues.reduce((a, b) => a + b, 0) / meanValues.length;
        aggregated.min = Math.min(...meanValues);
        aggregated.max = Math.max(...meanValues);
      }

      // Aggregate sum values
      const sumValues = hourValues.filter(v => v.sum !== undefined).map(v => v.sum!);
      if (sumValues.length > 0) {
        aggregated.sum = sumValues.reduce((a, b) => a + b, 0);
      }

      result.push(aggregated);
    }

    return result.sort((a, b) => a.start.localeCompare(b.start));
  }

  // ==========================================================================
  // Query Statistics
  // ==========================================================================

  async getStatistics(options: {
    statisticIds: string[];
    startTime: Date;
    endTime?: Date;
    period?: 'hour' | 'day' | 'week' | 'month';
  }): Promise<Record<string, StatisticEntry>> {
    const url = new URL(`${this.haBaseUrl}/api/history/statistics`);
    url.searchParams.set('statistic_ids', options.statisticIds.join(','));
    url.searchParams.set('start_time', options.startTime.toISOString());
    if (options.endTime) {
      url.searchParams.set('end_time', options.endTime.toISOString());
    }
    if (options.period) {
      url.searchParams.set('period', options.period);
    }

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.haToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get statistics: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('[HAStatistics] Query error:', error);
      return {};
    }
  }

  async getEnergyStatistics(period: 'day' | 'week' | 'month' = 'day'): Promise<{
    solarProduction: number;
    gridImport: number;
    gridExport: number;
    batteryCharge: number;
    batteryDischarge: number;
    consumption: number;
    selfConsumption: number;
    savings: number;
  }> {
    const now = new Date();
    const startTime = new Date(now);

    switch (period) {
      case 'day':
        startTime.setHours(0, 0, 0, 0);
        break;
      case 'week':
        startTime.setDate(now.getDate() - 7);
        break;
      case 'month':
        startTime.setMonth(now.getMonth() - 1);
        break;
    }

    const stats = await this.getStatistics({
      statisticIds: Object.values(this.STATISTICS).map(s => s.statistic_id),
      startTime,
      endTime: now,
      period: period === 'day' ? 'hour' : period,
    });

    const sumStat = (id: string): number => {
      const entry = stats[id];
      if (!entry?.statistics) return 0;
      return entry.statistics.reduce((sum, s) => sum + (s.sum || 0), 0);
    };

    const solarProduction = sumStat(this.STATISTICS.solar_production.statistic_id);
    const gridImport = sumStat(this.STATISTICS.grid_import.statistic_id);
    const gridExport = sumStat(this.STATISTICS.grid_export.statistic_id);
    const batteryCharge = sumStat(this.STATISTICS.battery_charge.statistic_id);
    const batteryDischarge = sumStat(this.STATISTICS.battery_discharge.statistic_id);
    const consumption = sumStat(this.STATISTICS.consumption.statistic_id);
    const savings = sumStat(this.STATISTICS.savings.statistic_id);

    const selfConsumption = solarProduction > 0 
      ? ((solarProduction - gridExport) / solarProduction) * 100
      : 0;

    return {
      solarProduction,
      gridImport,
      gridExport,
      batteryCharge,
      batteryDischarge,
      consumption,
      selfConsumption,
      savings,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

export const haStatistics = new HAStatisticsManager();

export default haStatistics;

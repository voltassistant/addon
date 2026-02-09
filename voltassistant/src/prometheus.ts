/**
 * Prometheus Metrics Exporter for VoltAssistant
 * Exposes metrics for Grafana monitoring and alerting
 */

import { getMultiInverterManager, AggregatedState, InverterState } from './multi-inverter';
import { getDecisionEngine } from './decision-engine';
import { getStorage } from './storage';

// Metric types
interface GaugeMetric {
  name: string;
  help: string;
  type: 'gauge';
  value: number;
  labels?: Record<string, string>;
}

interface CounterMetric {
  name: string;
  help: string;
  type: 'counter';
  value: number;
  labels?: Record<string, string>;
}

interface HistogramMetric {
  name: string;
  help: string;
  type: 'histogram';
  buckets: number[];
  values: number[];
  sum: number;
  count: number;
  labels?: Record<string, string>;
}

type Metric = GaugeMetric | CounterMetric | HistogramMetric;

// Metrics registry
const metrics: Map<string, Metric[]> = new Map();

// Metric names with voltassistant_ prefix
const METRIC_PREFIX = 'voltassistant_';

/**
 * Initialize metrics registry
 */
export function initializeMetrics(): void {
  // Clear any existing metrics
  metrics.clear();
  console.log('[Prometheus] Metrics initialized');
}

/**
 * Collect all current metrics
 */
export async function collectMetrics(): Promise<Metric[]> {
  const allMetrics: Metric[] = [];

  // Collect inverter metrics
  try {
    const inverterMetrics = collectInverterMetrics();
    allMetrics.push(...inverterMetrics);
  } catch (e) {
    console.error('[Prometheus] Error collecting inverter metrics:', e);
  }

  // Collect decision engine metrics
  try {
    const decisionMetrics = await collectDecisionMetrics();
    allMetrics.push(...decisionMetrics);
  } catch (e) {
    console.error('[Prometheus] Error collecting decision metrics:', e);
  }

  // Collect system metrics
  try {
    const systemMetrics = collectSystemMetrics();
    allMetrics.push(...systemMetrics);
  } catch (e) {
    console.error('[Prometheus] Error collecting system metrics:', e);
  }

  return allMetrics;
}

/**
 * Collect inverter-specific metrics
 */
function collectInverterMetrics(): Metric[] {
  const result: Metric[] = [];

  try {
    // Get multi-inverter manager (may not be initialized)
    const manager = (global as any).__multiInverterManager;
    if (!manager) return result;

    const aggregated: AggregatedState = manager.getAggregatedState();

    // Aggregated metrics
    result.push({
      name: `${METRIC_PREFIX}total_solar_power_watts`,
      help: 'Total solar power generation across all inverters',
      type: 'gauge',
      value: aggregated.totalSolarPower,
    });

    result.push({
      name: `${METRIC_PREFIX}total_battery_power_watts`,
      help: 'Total battery power (positive = charging)',
      type: 'gauge',
      value: aggregated.totalBatteryPower,
    });

    result.push({
      name: `${METRIC_PREFIX}total_load_power_watts`,
      help: 'Total load power consumption',
      type: 'gauge',
      value: aggregated.totalLoadPower,
    });

    result.push({
      name: `${METRIC_PREFIX}total_grid_power_watts`,
      help: 'Total grid power (positive = importing)',
      type: 'gauge',
      value: aggregated.totalGridPower,
    });

    result.push({
      name: `${METRIC_PREFIX}average_battery_level_percent`,
      help: 'Average battery level across all inverters',
      type: 'gauge',
      value: aggregated.averageBatteryLevel,
    });

    result.push({
      name: `${METRIC_PREFIX}weighted_battery_level_percent`,
      help: 'Weighted battery level by capacity',
      type: 'gauge',
      value: aggregated.weightedBatteryLevel,
    });

    result.push({
      name: `${METRIC_PREFIX}total_battery_capacity_kwh`,
      help: 'Total battery capacity across all inverters',
      type: 'gauge',
      value: aggregated.totalBatteryCapacity,
    });

    result.push({
      name: `${METRIC_PREFIX}inverters_online`,
      help: 'Number of inverters currently online',
      type: 'gauge',
      value: aggregated.onlineCount,
    });

    result.push({
      name: `${METRIC_PREFIX}inverters_total`,
      help: 'Total number of configured inverters',
      type: 'gauge',
      value: aggregated.totalCount,
    });

    // Per-inverter metrics
    for (const inverter of aggregated.inverters) {
      const labels = { inverter_id: inverter.id, inverter_name: inverter.name };

      result.push({
        name: `${METRIC_PREFIX}inverter_battery_level_percent`,
        help: 'Battery level for individual inverter',
        type: 'gauge',
        value: inverter.batteryLevel,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_battery_power_watts`,
        help: 'Battery power for individual inverter',
        type: 'gauge',
        value: inverter.batteryPower,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_solar_power_watts`,
        help: 'Solar power for individual inverter',
        type: 'gauge',
        value: inverter.solarPower,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_load_power_watts`,
        help: 'Load power for individual inverter',
        type: 'gauge',
        value: inverter.loadPower,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_grid_power_watts`,
        help: 'Grid power for individual inverter',
        type: 'gauge',
        value: inverter.gridPower,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_temperature_celsius`,
        help: 'Temperature for individual inverter',
        type: 'gauge',
        value: inverter.temperature,
        labels,
      });

      result.push({
        name: `${METRIC_PREFIX}inverter_online`,
        help: 'Whether inverter is online (1) or offline (0)',
        type: 'gauge',
        value: inverter.online ? 1 : 0,
        labels,
      });

      // Status as numeric enum
      const statusValue = {
        'idle': 0,
        'charging': 1,
        'discharging': 2,
        'grid_tie': 3,
        'off_grid': 4,
        'fault': 5,
      }[inverter.status] ?? -1;

      result.push({
        name: `${METRIC_PREFIX}inverter_status`,
        help: 'Inverter status (0=idle, 1=charging, 2=discharging, 3=grid_tie, 4=off_grid, 5=fault)',
        type: 'gauge',
        value: statusValue,
        labels,
      });
    }
  } catch (e) {
    console.error('[Prometheus] Error in collectInverterMetrics:', e);
  }

  return result;
}

/**
 * Collect decision engine metrics
 */
async function collectDecisionMetrics(): Promise<Metric[]> {
  const result: Metric[] = [];

  try {
    const storage = getStorage();

    // Get decision history stats
    const history = await storage.get('decisionHistory') as any[] || [];
    const last24h = history.filter((d: any) => Date.now() - d.timestamp < 24 * 60 * 60 * 1000);

    result.push({
      name: `${METRIC_PREFIX}decisions_total`,
      help: 'Total number of decisions made',
      type: 'counter',
      value: history.length,
    });

    result.push({
      name: `${METRIC_PREFIX}decisions_last_24h`,
      help: 'Number of decisions made in last 24 hours',
      type: 'gauge',
      value: last24h.length,
    });

    // Count decisions by type
    const decisionCounts: Record<string, number> = {};
    for (const decision of last24h) {
      const action = decision.action || 'unknown';
      decisionCounts[action] = (decisionCounts[action] || 0) + 1;
    }

    for (const [action, count] of Object.entries(decisionCounts)) {
      result.push({
        name: `${METRIC_PREFIX}decisions_by_action`,
        help: 'Number of decisions by action type in last 24h',
        type: 'gauge',
        value: count,
        labels: { action },
      });
    }

    // Get savings stats
    const savings = await storage.get('savingsStats') as any;
    if (savings) {
      result.push({
        name: `${METRIC_PREFIX}savings_euros_total`,
        help: 'Total estimated savings in euros',
        type: 'counter',
        value: savings.totalSavings || 0,
      });

      result.push({
        name: `${METRIC_PREFIX}savings_kwh_total`,
        help: 'Total kWh optimized',
        type: 'counter',
        value: savings.totalKwhOptimized || 0,
      });

      result.push({
        name: `${METRIC_PREFIX}savings_euros_today`,
        help: 'Estimated savings today in euros',
        type: 'gauge',
        value: savings.todaySavings || 0,
      });
    }
  } catch (e) {
    console.error('[Prometheus] Error in collectDecisionMetrics:', e);
  }

  return result;
}

/**
 * Collect system metrics
 */
function collectSystemMetrics(): Metric[] {
  const result: Metric[] = [];

  // Uptime
  result.push({
    name: `${METRIC_PREFIX}uptime_seconds`,
    help: 'Addon uptime in seconds',
    type: 'counter',
    value: process.uptime(),
  });

  // Memory usage
  const memUsage = process.memoryUsage();
  result.push({
    name: `${METRIC_PREFIX}memory_heap_used_bytes`,
    help: 'Heap memory used in bytes',
    type: 'gauge',
    value: memUsage.heapUsed,
  });

  result.push({
    name: `${METRIC_PREFIX}memory_heap_total_bytes`,
    help: 'Total heap memory in bytes',
    type: 'gauge',
    value: memUsage.heapTotal,
  });

  result.push({
    name: `${METRIC_PREFIX}memory_rss_bytes`,
    help: 'Resident set size in bytes',
    type: 'gauge',
    value: memUsage.rss,
  });

  // Timestamp
  result.push({
    name: `${METRIC_PREFIX}last_scrape_timestamp`,
    help: 'Unix timestamp of last metrics scrape',
    type: 'gauge',
    value: Date.now() / 1000,
  });

  return result;
}

/**
 * Format metrics in Prometheus exposition format
 */
export function formatPrometheusMetrics(metrics: Metric[]): string {
  const lines: string[] = [];

  // Group metrics by name
  const groupedMetrics = new Map<string, Metric[]>();
  for (const metric of metrics) {
    const existing = groupedMetrics.get(metric.name) || [];
    existing.push(metric);
    groupedMetrics.set(metric.name, existing);
  }

  // Format each metric
  for (const [name, metricsGroup] of groupedMetrics) {
    const first = metricsGroup[0];

    // HELP line
    lines.push(`# HELP ${name} ${first.help}`);

    // TYPE line
    lines.push(`# TYPE ${name} ${first.type}`);

    // Value lines
    for (const metric of metricsGroup) {
      if (metric.labels && Object.keys(metric.labels).length > 0) {
        const labelStr = Object.entries(metric.labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',');
        lines.push(`${name}{${labelStr}} ${metric.value}`);
      } else {
        lines.push(`${name} ${metric.value}`);
      }
    }

    lines.push(''); // Empty line between metrics
  }

  return lines.join('\n');
}

/**
 * Escape label values for Prometheus format
 */
function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * HTTP handler for /metrics endpoint
 */
export async function handleMetricsRequest(): Promise<{ body: string; contentType: string }> {
  const allMetrics = await collectMetrics();
  const formatted = formatPrometheusMetrics(allMetrics);

  return {
    body: formatted,
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
  };
}

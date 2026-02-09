/**
 * Diagnostic Information for Troubleshooting
 * 
 * Features:
 * - System information collection
 * - Inverter communication diagnostics
 * - Network connectivity tests
 * - Log collection and analysis
 * - Self-diagnosis with recommendations
 */

// ============================================================================
// Types
// ============================================================================

export interface DiagnosticResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: Record<string, unknown>;
  recommendations?: string[];
}

export interface SystemInfo {
  addon: {
    version: string;
    uptime: number;
    memoryUsage: NodeJS.MemoryUsage;
    nodeVersion: string;
    platform: string;
  };
  homeAssistant: {
    version?: string;
    connected: boolean;
    supervisorConnected: boolean;
  };
  inverter: {
    connected: boolean;
    model?: string;
    firmware?: string;
    lastCommunication?: string;
  };
  pvpc: {
    lastUpdate?: string;
    todayPricesAvailable: boolean;
    tomorrowPricesAvailable: boolean;
  };
}

export interface DiagnosticReport {
  timestamp: string;
  systemInfo: SystemInfo;
  checks: DiagnosticResult[];
  overallStatus: 'healthy' | 'degraded' | 'critical';
  summary: string;
}

// ============================================================================
// State (in-memory for demo)
// ============================================================================

interface DiagnosticState {
  startTime: number;
  lastInverterCommunication: Date | null;
  lastPvpcUpdate: Date | null;
  todayPricesAvailable: boolean;
  tomorrowPricesAvailable: boolean;
  inverterErrors: string[];
  pvpcErrors: string[];
  communicationLatencies: number[];
}

const state: DiagnosticState = {
  startTime: Date.now(),
  lastInverterCommunication: null,
  lastPvpcUpdate: null,
  todayPricesAvailable: false,
  tomorrowPricesAvailable: false,
  inverterErrors: [],
  pvpcErrors: [],
  communicationLatencies: [],
};

// ============================================================================
// System Information
// ============================================================================

export async function getSystemInfo(): Promise<SystemInfo> {
  const memoryUsage = process.memoryUsage();
  const uptime = Math.round((Date.now() - state.startTime) / 1000);

  // Check HA connection
  const haConnected = await checkHomeAssistantConnection();
  const supervisorConnected = await checkSupervisorConnection();
  const haVersion = await getHomeAssistantVersion();

  // Inverter info
  const inverterConnected = state.lastInverterCommunication !== null &&
    (Date.now() - state.lastInverterCommunication.getTime()) < 60000;

  return {
    addon: {
      version: process.env.ADDON_VERSION || '1.0.0',
      uptime,
      memoryUsage,
      nodeVersion: process.version,
      platform: process.platform,
    },
    homeAssistant: {
      version: haVersion,
      connected: haConnected,
      supervisorConnected,
    },
    inverter: {
      connected: inverterConnected,
      model: process.env.INVERTER_MODEL || 'Deye Hybrid',
      firmware: process.env.INVERTER_FIRMWARE,
      lastCommunication: state.lastInverterCommunication?.toISOString(),
    },
    pvpc: {
      lastUpdate: state.lastPvpcUpdate?.toISOString(),
      todayPricesAvailable: state.todayPricesAvailable,
      tomorrowPricesAvailable: state.tomorrowPricesAvailable,
    },
  };
}

async function checkHomeAssistantConnection(): Promise<boolean> {
  try {
    const response = await fetch(
      `${process.env.HA_BASE_URL || 'http://supervisor/core'}/api/`,
      {
        headers: {
          Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function checkSupervisorConnection(): Promise<boolean> {
  try {
    const response = await fetch('http://supervisor/supervisor/ping', {
      headers: {
        Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function getHomeAssistantVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${process.env.HA_BASE_URL || 'http://supervisor/core'}/api/config`,
      {
        headers: {
          Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`,
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (response.ok) {
      const config = await response.json();
      return config.version;
    }
  } catch {
    // Ignore
  }
  return undefined;
}

// ============================================================================
// Diagnostic Checks
// ============================================================================

export async function runDiagnostics(): Promise<DiagnosticReport> {
  const checks: DiagnosticResult[] = [];
  const systemInfo = await getSystemInfo();

  // Memory check
  checks.push(checkMemory(systemInfo.addon.memoryUsage));

  // HA connection check
  checks.push(checkHomeAssistant(systemInfo.homeAssistant));

  // Inverter check
  checks.push(checkInverter(systemInfo.inverter));

  // PVPC check
  checks.push(checkPVPC(systemInfo.pvpc));

  // Network latency check
  checks.push(checkNetworkLatency());

  // Recent errors check
  checks.push(checkRecentErrors());

  // Configuration check
  checks.push(checkConfiguration());

  // Determine overall status
  const hasErrors = checks.some(c => c.status === 'error');
  const hasWarnings = checks.some(c => c.status === 'warning');

  const overallStatus = hasErrors ? 'critical' : hasWarnings ? 'degraded' : 'healthy';

  // Generate summary
  const summary = generateSummary(checks, overallStatus);

  return {
    timestamp: new Date().toISOString(),
    systemInfo,
    checks,
    overallStatus,
    summary,
  };
}

function checkMemory(usage: NodeJS.MemoryUsage): DiagnosticResult {
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const ratio = usage.heapUsed / usage.heapTotal;

  if (ratio > 0.9) {
    return {
      name: 'Memory Usage',
      status: 'error',
      message: `Critical memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${Math.round(ratio * 100)}%)`,
      details: { heapUsedMB, heapTotalMB, ratio },
      recommendations: [
        'Restart the addon to free memory',
        'Check for memory leaks in recent changes',
        'Consider increasing container memory limit',
      ],
    };
  }

  if (ratio > 0.7) {
    return {
      name: 'Memory Usage',
      status: 'warning',
      message: `High memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${Math.round(ratio * 100)}%)`,
      details: { heapUsedMB, heapTotalMB, ratio },
      recommendations: ['Monitor memory usage', 'Consider restarting if it continues to grow'],
    };
  }

  return {
    name: 'Memory Usage',
    status: 'ok',
    message: `Memory OK: ${heapUsedMB}MB / ${heapTotalMB}MB (${Math.round(ratio * 100)}%)`,
    details: { heapUsedMB, heapTotalMB, ratio },
  };
}

function checkHomeAssistant(ha: SystemInfo['homeAssistant']): DiagnosticResult {
  if (!ha.supervisorConnected) {
    return {
      name: 'Home Assistant Connection',
      status: 'error',
      message: 'Cannot connect to HA Supervisor',
      recommendations: [
        'Check if the addon is running in Home Assistant',
        'Verify SUPERVISOR_TOKEN environment variable',
        'Check network connectivity',
      ],
    };
  }

  if (!ha.connected) {
    return {
      name: 'Home Assistant Connection',
      status: 'warning',
      message: 'Supervisor connected but Core API unreachable',
      details: { version: ha.version },
      recommendations: [
        'Home Assistant Core may be restarting',
        'Check Home Assistant logs for errors',
      ],
    };
  }

  return {
    name: 'Home Assistant Connection',
    status: 'ok',
    message: `Connected to Home Assistant ${ha.version || 'unknown version'}`,
    details: { version: ha.version },
  };
}

function checkInverter(inverter: SystemInfo['inverter']): DiagnosticResult {
  if (!inverter.connected) {
    const lastComm = inverter.lastCommunication;
    return {
      name: 'Inverter Connection',
      status: 'error',
      message: lastComm
        ? `Lost connection. Last communication: ${lastComm}`
        : 'Never connected to inverter',
      details: { model: inverter.model, lastCommunication: lastComm },
      recommendations: [
        'Check inverter IP address in configuration',
        'Verify inverter is powered on and connected to network',
        'Check Modbus settings (port 502, slave ID 1)',
        'Try restarting the inverter',
      ],
    };
  }

  return {
    name: 'Inverter Connection',
    status: 'ok',
    message: `Connected to ${inverter.model || 'inverter'}`,
    details: {
      model: inverter.model,
      firmware: inverter.firmware,
      lastCommunication: inverter.lastCommunication,
    },
  };
}

function checkPVPC(pvpc: SystemInfo['pvpc']): DiagnosticResult {
  if (!pvpc.todayPricesAvailable) {
    return {
      name: 'PVPC Prices',
      status: 'error',
      message: "Today's prices not available",
      details: { lastUpdate: pvpc.lastUpdate },
      recommendations: [
        'Check internet connectivity',
        'REE API may be temporarily unavailable',
        'Try manually refreshing prices',
      ],
    };
  }

  const now = new Date();
  if (now.getHours() >= 20 && !pvpc.tomorrowPricesAvailable) {
    return {
      name: 'PVPC Prices',
      status: 'warning',
      message: "Tomorrow's prices not yet available (usually published around 20:30)",
      details: { lastUpdate: pvpc.lastUpdate, todayAvailable: true, tomorrowAvailable: false },
    };
  }

  return {
    name: 'PVPC Prices',
    status: 'ok',
    message: 'PVPC prices up to date',
    details: {
      lastUpdate: pvpc.lastUpdate,
      todayAvailable: pvpc.todayPricesAvailable,
      tomorrowAvailable: pvpc.tomorrowPricesAvailable,
    },
  };
}

function checkNetworkLatency(): DiagnosticResult {
  if (state.communicationLatencies.length === 0) {
    return {
      name: 'Network Latency',
      status: 'warning',
      message: 'No latency data available yet',
    };
  }

  const avgLatency = state.communicationLatencies.reduce((a, b) => a + b, 0) /
    state.communicationLatencies.length;
  const maxLatency = Math.max(...state.communicationLatencies);

  if (avgLatency > 1000) {
    return {
      name: 'Network Latency',
      status: 'error',
      message: `High average latency: ${Math.round(avgLatency)}ms`,
      details: { avgLatency: Math.round(avgLatency), maxLatency },
      recommendations: [
        'Check network congestion',
        'Inverter may be on a slow/unreliable network',
        'Consider using wired ethernet instead of WiFi',
      ],
    };
  }

  if (avgLatency > 500) {
    return {
      name: 'Network Latency',
      status: 'warning',
      message: `Elevated latency: ${Math.round(avgLatency)}ms average`,
      details: { avgLatency: Math.round(avgLatency), maxLatency },
      recommendations: ['Monitor for further degradation'],
    };
  }

  return {
    name: 'Network Latency',
    status: 'ok',
    message: `Latency OK: ${Math.round(avgLatency)}ms average`,
    details: { avgLatency: Math.round(avgLatency), maxLatency },
  };
}

function checkRecentErrors(): DiagnosticResult {
  const recentInverterErrors = state.inverterErrors.slice(-10);
  const recentPvpcErrors = state.pvpcErrors.slice(-10);
  const totalErrors = recentInverterErrors.length + recentPvpcErrors.length;

  if (totalErrors > 5) {
    return {
      name: 'Recent Errors',
      status: 'warning',
      message: `${totalErrors} errors in recent history`,
      details: {
        inverterErrors: recentInverterErrors,
        pvpcErrors: recentPvpcErrors,
      },
      recommendations: [
        'Review error logs for patterns',
        'Check if errors correlate with specific times',
      ],
    };
  }

  return {
    name: 'Recent Errors',
    status: 'ok',
    message: totalErrors > 0 ? `${totalErrors} minor errors` : 'No recent errors',
  };
}

function checkConfiguration(): DiagnosticResult {
  const missingConfig: string[] = [];

  if (!process.env.INVERTER_IP) {
    missingConfig.push('INVERTER_IP');
  }

  if (missingConfig.length > 0) {
    return {
      name: 'Configuration',
      status: 'error',
      message: `Missing required configuration: ${missingConfig.join(', ')}`,
      recommendations: [
        'Open addon configuration in Home Assistant',
        'Fill in all required fields',
        'Restart the addon after saving',
      ],
    };
  }

  return {
    name: 'Configuration',
    status: 'ok',
    message: 'All required configuration present',
  };
}

function generateSummary(checks: DiagnosticResult[], status: string): string {
  const errorChecks = checks.filter(c => c.status === 'error');
  const warningChecks = checks.filter(c => c.status === 'warning');

  if (status === 'healthy') {
    return 'All systems operational. VoltAssistant is running normally.';
  }

  if (status === 'critical') {
    return `Critical issues detected: ${errorChecks.map(c => c.name).join(', ')}. ` +
      'Immediate action required.';
  }

  return `System degraded: ${warningChecks.map(c => c.name).join(', ')}. ` +
    'Review warnings and take action if issues persist.';
}

// ============================================================================
// State Updates (called by other modules)
// ============================================================================

export function recordInverterCommunication(latencyMs: number): void {
  state.lastInverterCommunication = new Date();
  state.communicationLatencies.push(latencyMs);
  
  // Keep only last 100 latencies
  if (state.communicationLatencies.length > 100) {
    state.communicationLatencies.shift();
  }
}

export function recordInverterError(error: string): void {
  state.inverterErrors.push(`${new Date().toISOString()}: ${error}`);
  
  // Keep only last 50 errors
  if (state.inverterErrors.length > 50) {
    state.inverterErrors.shift();
  }
}

export function recordPvpcUpdate(todayAvailable: boolean, tomorrowAvailable: boolean): void {
  state.lastPvpcUpdate = new Date();
  state.todayPricesAvailable = todayAvailable;
  state.tomorrowPricesAvailable = tomorrowAvailable;
}

export function recordPvpcError(error: string): void {
  state.pvpcErrors.push(`${new Date().toISOString()}: ${error}`);
  
  // Keep only last 50 errors
  if (state.pvpcErrors.length > 50) {
    state.pvpcErrors.shift();
  }
}

// ============================================================================
// Log Collection
// ============================================================================

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

const logBuffer: LogEntry[] = [];
const MAX_LOG_ENTRIES = 1000;

export function addLogEntry(entry: LogEntry): void {
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

export function getRecentLogs(options?: {
  level?: string;
  limit?: number;
  since?: Date;
}): LogEntry[] {
  let logs = [...logBuffer];

  if (options?.level) {
    logs = logs.filter(l => l.level === options.level);
  }

  if (options?.since) {
    logs = logs.filter(l => new Date(l.timestamp) >= options.since!);
  }

  if (options?.limit) {
    logs = logs.slice(-options.limit);
  }

  return logs;
}

export function exportLogsAsText(): string {
  return logBuffer
    .map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message}`)
    .join('\n');
}

// ============================================================================
// Export
// ============================================================================

export default {
  getSystemInfo,
  runDiagnostics,
  recordInverterCommunication,
  recordInverterError,
  recordPvpcUpdate,
  recordPvpcError,
  addLogEntry,
  getRecentLogs,
  exportLogsAsText,
};

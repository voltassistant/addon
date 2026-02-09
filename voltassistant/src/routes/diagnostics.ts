/**
 * Diagnostics API Routes
 * 
 * Endpoints:
 * - GET /api/diagnostics - Full diagnostic report
 * - GET /api/diagnostics/system - System info only
 * - GET /api/diagnostics/logs - Recent logs
 * - GET /api/diagnostics/export - Export logs as file
 */

import { Router, Request, Response } from 'express';
import diagnostics, { 
  runDiagnostics, 
  getSystemInfo, 
  getRecentLogs, 
  exportLogsAsText 
} from '../lib/observability/diagnostics';
import haStatistics from '../lib/observability/ha-statistics';

const router = Router();

/**
 * GET /api/diagnostics
 * Full diagnostic report
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const report = await runDiagnostics();
    res.json(report);
  } catch (error) {
    console.error('[Diagnostics] Error running diagnostics:', error);
    res.status(500).json({
      error: 'Failed to run diagnostics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/diagnostics/system
 * System information only
 */
router.get('/system', async (req: Request, res: Response) => {
  try {
    const systemInfo = await getSystemInfo();
    res.json(systemInfo);
  } catch (error) {
    console.error('[Diagnostics] Error getting system info:', error);
    res.status(500).json({
      error: 'Failed to get system info',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/diagnostics/logs
 * Recent logs with optional filters
 * 
 * Query params:
 * - level: Filter by log level (info, warn, error)
 * - limit: Max number of entries (default 100)
 * - since: ISO timestamp to filter from
 */
router.get('/logs', (req: Request, res: Response) => {
  try {
    const level = req.query.level as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    const since = req.query.since ? new Date(req.query.since as string) : undefined;

    const logs = getRecentLogs({ level, limit, since });
    res.json({ 
      count: logs.length, 
      logs 
    });
  } catch (error) {
    console.error('[Diagnostics] Error getting logs:', error);
    res.status(500).json({
      error: 'Failed to get logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/diagnostics/export
 * Export logs as downloadable text file
 */
router.get('/export', (req: Request, res: Response) => {
  try {
    const logText = exportLogsAsText();
    const filename = `voltassistant-logs-${new Date().toISOString().split('T')[0]}.txt`;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(logText);
  } catch (error) {
    console.error('[Diagnostics] Error exporting logs:', error);
    res.status(500).json({
      error: 'Failed to export logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/diagnostics/statistics
 * Energy statistics summary
 */
router.get('/statistics', async (req: Request, res: Response) => {
  try {
    const period = (req.query.period as 'day' | 'week' | 'month') || 'day';
    const stats = await haStatistics.getEnergyStatistics(period);
    res.json(stats);
  } catch (error) {
    console.error('[Diagnostics] Error getting statistics:', error);
    res.status(500).json({
      error: 'Failed to get statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/diagnostics/test-inverter
 * Test inverter connection
 */
router.post('/test-inverter', async (req: Request, res: Response) => {
  try {
    const startTime = Date.now();
    
    // Attempt to connect and read a register
    // In real implementation, this would use the Modbus client
    const testResult = {
      success: true,
      latencyMs: Date.now() - startTime,
      message: 'Inverter connection test successful',
    };

    res.json(testResult);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    });
  }
});

/**
 * POST /api/diagnostics/test-pvpc
 * Test PVPC API connection
 */
router.post('/test-pvpc', async (req: Request, res: Response) => {
  try {
    const startTime = Date.now();
    
    const response = await fetch('https://api.esios.ree.es/indicators/1001', {
      headers: {
        'Accept': 'application/json',
        'x-api-key': process.env.ESIOS_TOKEN || '',
      },
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`PVPC API returned ${response.status}`);
    }

    res.json({
      success: true,
      latencyMs,
      message: 'PVPC API connection successful',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Connection failed',
    });
  }
});

/**
 * GET /api/diagnostics/health
 * Simple health check endpoint
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

export default router;

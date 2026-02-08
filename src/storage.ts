/**
 * SQLite Storage for VoltAssistant
 * Persists decisions, stats, alerts, and configuration
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

// Types
export interface Decision {
  id?: number
  timestamp: string
  soc: number
  price: number
  solar_watts: number
  action: 'charge_from_grid' | 'charge_from_solar' | 'discharge' | 'idle'
  reason: string
  executed: boolean
  error?: string
}

export interface HourlyStat {
  date: string
  hour: number
  price: number
  solar_kwh: number
  consumption_kwh: number
  grid_import_kwh: number
  grid_export_kwh: number
  battery_soc: number
}

export interface StoredAlert {
  id?: number
  type: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  acknowledged: boolean
  created_at: string
  ack_at?: string
}

export interface ConfigEntry {
  key: string
  value: string
  updated_at: string
}

// Database singleton
let db: Database.Database | null = null

function getDbPath(): string {
  const dataDir = path.join(__dirname, '..', 'data')
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }
  return path.join(dataDir, 'voltassistant.db')
}

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    initializeSchema()
  }
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function initializeSchema(): void {
  const database = getDb()

  // Decisions table
  database.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      soc REAL NOT NULL,
      price REAL NOT NULL,
      solar_watts REAL NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      executed INTEGER DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Hourly stats table
  database.exec(`
    CREATE TABLE IF NOT EXISTS hourly_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      price REAL,
      solar_kwh REAL DEFAULT 0,
      consumption_kwh REAL DEFAULT 0,
      grid_import_kwh REAL DEFAULT 0,
      grid_export_kwh REAL DEFAULT 0,
      battery_soc REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, hour)
    )
  `)

  // Alerts table
  database.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      ack_at TEXT
    )
  `)

  // Config table
  database.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  // Indexes for performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_hourly_stats_date ON hourly_stats(date);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged);
  `)

  console.log('📦 SQLite database initialized')
}

// ═══════════════════════════════════════════════════════════════════════════
// DECISIONS
// ═══════════════════════════════════════════════════════════════════════════

export function saveDecision(decision: Decision): number {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO decisions (timestamp, soc, price, solar_watts, action, reason, executed, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    decision.timestamp,
    decision.soc,
    decision.price,
    decision.solar_watts,
    decision.action,
    decision.reason,
    decision.executed ? 1 : 0,
    decision.error || null
  )
  return result.lastInsertRowid as number
}

export function updateDecisionExecution(id: number, executed: boolean, error?: string): void {
  const database = getDb()
  const stmt = database.prepare(`
    UPDATE decisions SET executed = ?, error = ? WHERE id = ?
  `)
  stmt.run(executed ? 1 : 0, error || null, id)
}

export function getRecentDecisions(limit: number = 50): Decision[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?
  `)
  const rows = stmt.all(limit) as any[]
  return rows.map(row => ({
    ...row,
    executed: Boolean(row.executed)
  }))
}

export function getDecisionsByDateRange(start: string, end: string): Decision[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM decisions 
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
  `)
  const rows = stmt.all(start, end) as any[]
  return rows.map(row => ({
    ...row,
    executed: Boolean(row.executed)
  }))
}

export function getLastDecision(): Decision | null {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM decisions ORDER BY timestamp DESC LIMIT 1
  `)
  const row = stmt.get() as any
  if (!row) return null
  return { ...row, executed: Boolean(row.executed) }
}

// ═══════════════════════════════════════════════════════════════════════════
// HOURLY STATS
// ═══════════════════════════════════════════════════════════════════════════

export function saveHourlyStat(stat: HourlyStat): void {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO hourly_stats 
    (date, hour, price, solar_kwh, consumption_kwh, grid_import_kwh, grid_export_kwh, battery_soc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    stat.date,
    stat.hour,
    stat.price,
    stat.solar_kwh,
    stat.consumption_kwh,
    stat.grid_import_kwh,
    stat.grid_export_kwh,
    stat.battery_soc
  )
}

export function getHourlyStats(date: string): HourlyStat[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM hourly_stats WHERE date = ? ORDER BY hour
  `)
  return stmt.all(date) as HourlyStat[]
}

export function getStatsDateRange(start: string, end: string): HourlyStat[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM hourly_stats 
    WHERE date >= ? AND date <= ?
    ORDER BY date, hour
  `)
  return stmt.all(start, end) as HourlyStat[]
}

export function getDailySummary(date: string): {
  total_solar_kwh: number
  total_consumption_kwh: number
  total_grid_import_kwh: number
  total_grid_export_kwh: number
  avg_price: number
} | null {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT 
      SUM(solar_kwh) as total_solar_kwh,
      SUM(consumption_kwh) as total_consumption_kwh,
      SUM(grid_import_kwh) as total_grid_import_kwh,
      SUM(grid_export_kwh) as total_grid_export_kwh,
      AVG(price) as avg_price
    FROM hourly_stats WHERE date = ?
  `)
  const row = stmt.get(date) as any
  if (!row || row.total_solar_kwh === null) return null
  return row
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════

export function saveAlert(alert: Omit<StoredAlert, 'id'>): number {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO alerts (type, severity, message, acknowledged, created_at, ack_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    alert.type,
    alert.severity,
    alert.message,
    alert.acknowledged ? 1 : 0,
    alert.created_at,
    alert.ack_at || null
  )
  return result.lastInsertRowid as number
}

export function getActiveAlerts(): StoredAlert[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC
  `)
  const rows = stmt.all() as any[]
  return rows.map(row => ({ ...row, acknowledged: Boolean(row.acknowledged) }))
}

export function getAlertHistory(limit: number = 100): StoredAlert[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?
  `)
  const rows = stmt.all(limit) as any[]
  return rows.map(row => ({ ...row, acknowledged: Boolean(row.acknowledged) }))
}

export function acknowledgeAlert(id: number): boolean {
  const database = getDb()
  const stmt = database.prepare(`
    UPDATE alerts SET acknowledged = 1, ack_at = ? WHERE id = ?
  `)
  const result = stmt.run(new Date().toISOString(), id)
  return result.changes > 0
}

export function acknowledgeAlertByType(type: string): number {
  const database = getDb()
  const stmt = database.prepare(`
    UPDATE alerts SET acknowledged = 1, ack_at = ? 
    WHERE type = ? AND acknowledged = 0
  `)
  const result = stmt.run(new Date().toISOString(), type)
  return result.changes
}

export function hasActiveAlertOfType(type: string): boolean {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT 1 FROM alerts WHERE type = ? AND acknowledged = 0 LIMIT 1
  `)
  return stmt.get(type) !== undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export function getConfigValue(key: string): string | null {
  const database = getDb()
  const stmt = database.prepare(`SELECT value FROM config WHERE key = ?`)
  const row = stmt.get(key) as any
  return row?.value || null
}

export function setConfigValue(key: string, value: string): void {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)
  `)
  stmt.run(key, value, new Date().toISOString())
}

export function getAllConfig(): Record<string, string> {
  const database = getDb()
  const stmt = database.prepare(`SELECT key, value FROM config`)
  const rows = stmt.all() as any[]
  const config: Record<string, string> = {}
  for (const row of rows) {
    config[row.key] = row.value
  }
  return config
}

export function deleteConfigValue(key: string): boolean {
  const database = getDb()
  const stmt = database.prepare(`DELETE FROM config WHERE key = ?`)
  const result = stmt.run(key)
  return result.changes > 0
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP & MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════

export function cleanupOldData(daysToKeep: number = 90): {
  deletedDecisions: number
  deletedStats: number
  deletedAlerts: number
} {
  const database = getDb()
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)
  const cutoff = cutoffDate.toISOString()

  const deleteDecisions = database.prepare(`
    DELETE FROM decisions WHERE timestamp < ?
  `)
  const deleteStats = database.prepare(`
    DELETE FROM hourly_stats WHERE date < ?
  `)
  const deleteAlerts = database.prepare(`
    DELETE FROM alerts WHERE created_at < ? AND acknowledged = 1
  `)

  const cutoffDateStr = cutoff.split('T')[0]

  return {
    deletedDecisions: deleteDecisions.run(cutoff).changes,
    deletedStats: deleteStats.run(cutoffDateStr).changes,
    deletedAlerts: deleteAlerts.run(cutoff).changes,
  }
}

export function getDatabaseStats(): {
  decisions: number
  hourlyStats: number
  alerts: number
  activeAlerts: number
  sizeBytes: number
} {
  const database = getDb()
  
  const decisionsCount = (database.prepare(`SELECT COUNT(*) as c FROM decisions`).get() as any).c
  const statsCount = (database.prepare(`SELECT COUNT(*) as c FROM hourly_stats`).get() as any).c
  const alertsCount = (database.prepare(`SELECT COUNT(*) as c FROM alerts`).get() as any).c
  const activeAlertsCount = (database.prepare(`SELECT COUNT(*) as c FROM alerts WHERE acknowledged = 0`).get() as any).c

  const dbPath = getDbPath()
  const stats = fs.statSync(dbPath)

  return {
    decisions: decisionsCount,
    hourlyStats: statsCount,
    alerts: alertsCount,
    activeAlerts: activeAlertsCount,
    sizeBytes: stats.size,
  }
}

/**
 * SQLite Storage for VoltAssistant
 * Persists decisions, stats, alerts, configuration, and load management state
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

// Load Management Types
export interface LoadAction {
  id?: number
  timestamp: string
  device_id: string
  device_name: string
  action: 'shed' | 'restore'
  reason: string
  soc: number
  price: number
  solar_watts?: number
  load_watts?: number
}

export interface LoadState {
  device_id: string
  is_shed: boolean
  shed_since: string | null
  shed_reason: string | null
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

  // Load Actions table - history of shed/restore actions
  database.exec(`
    CREATE TABLE IF NOT EXISTS load_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      soc REAL,
      price REAL,
      solar_watts REAL,
      load_watts REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // Load State table - current state of each load
  database.exec(`
    CREATE TABLE IF NOT EXISTS load_state (
      device_id TEXT PRIMARY KEY,
      is_shed INTEGER DEFAULT 0,
      shed_since TEXT,
      shed_reason TEXT,
      updated_at TEXT NOT NULL
    )
  `)

  // Indexes for performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_hourly_stats_date ON hourly_stats(date);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged);
    CREATE INDEX IF NOT EXISTS idx_load_actions_timestamp ON load_actions(timestamp);
    CREATE INDEX IF NOT EXISTS idx_load_actions_device ON load_actions(device_id);
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
// LOAD ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

export function saveLoadAction(action: Omit<LoadAction, 'id'>): number {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT INTO load_actions (timestamp, device_id, device_name, action, reason, soc, price, solar_watts, load_watts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    action.timestamp,
    action.device_id,
    action.device_name,
    action.action,
    action.reason,
    action.soc,
    action.price,
    action.solar_watts || null,
    action.load_watts || null
  )
  return result.lastInsertRowid as number
}

export function getLoadActionHistory(limit: number = 100): LoadAction[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM load_actions ORDER BY timestamp DESC LIMIT ?
  `)
  return stmt.all(limit) as LoadAction[]
}

export function getLoadActionsByDevice(deviceId: string, limit: number = 50): LoadAction[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM load_actions WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?
  `)
  return stmt.all(deviceId, limit) as LoadAction[]
}

export function getLoadActionsByDateRange(start: string, end: string): LoadAction[] {
  const database = getDb()
  const stmt = database.prepare(`
    SELECT * FROM load_actions 
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
  `)
  return stmt.all(start, end) as LoadAction[]
}

export function getLoadActionStats(days: number = 7): {
  total_sheds: number
  total_restores: number
  by_device: { device_id: string; device_name: string; sheds: number; restores: number }[]
} {
  const database = getDb()
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString()

  const totalStmt = database.prepare(`
    SELECT 
      SUM(CASE WHEN action = 'shed' THEN 1 ELSE 0 END) as total_sheds,
      SUM(CASE WHEN action = 'restore' THEN 1 ELSE 0 END) as total_restores
    FROM load_actions WHERE timestamp >= ?
  `)
  const totals = totalStmt.get(cutoffStr) as any

  const byDeviceStmt = database.prepare(`
    SELECT 
      device_id,
      device_name,
      SUM(CASE WHEN action = 'shed' THEN 1 ELSE 0 END) as sheds,
      SUM(CASE WHEN action = 'restore' THEN 1 ELSE 0 END) as restores
    FROM load_actions 
    WHERE timestamp >= ?
    GROUP BY device_id, device_name
  `)
  const byDevice = byDeviceStmt.all(cutoffStr) as any[]

  return {
    total_sheds: totals?.total_sheds || 0,
    total_restores: totals?.total_restores || 0,
    by_device: byDevice,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOAD STATE
// ═══════════════════════════════════════════════════════════════════════════

export function getLoadState(deviceId: string): LoadState | null {
  const database = getDb()
  const stmt = database.prepare(`SELECT * FROM load_state WHERE device_id = ?`)
  const row = stmt.get(deviceId) as any
  if (!row) return null
  return {
    device_id: row.device_id,
    is_shed: Boolean(row.is_shed),
    shed_since: row.shed_since,
    shed_reason: row.shed_reason,
    updated_at: row.updated_at,
  }
}

export function getAllLoadStates(): LoadState[] {
  const database = getDb()
  const stmt = database.prepare(`SELECT * FROM load_state`)
  const rows = stmt.all() as any[]
  return rows.map(row => ({
    device_id: row.device_id,
    is_shed: Boolean(row.is_shed),
    shed_since: row.shed_since,
    shed_reason: row.shed_reason,
    updated_at: row.updated_at,
  }))
}

export function setLoadState(state: LoadState): void {
  const database = getDb()
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO load_state (device_id, is_shed, shed_since, shed_reason, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `)
  stmt.run(
    state.device_id,
    state.is_shed ? 1 : 0,
    state.shed_since,
    state.shed_reason,
    state.updated_at
  )
}

export function markLoadShed(deviceId: string, reason: string): void {
  const now = new Date().toISOString()
  setLoadState({
    device_id: deviceId,
    is_shed: true,
    shed_since: now,
    shed_reason: reason,
    updated_at: now,
  })
}

export function markLoadRestored(deviceId: string): void {
  const now = new Date().toISOString()
  setLoadState({
    device_id: deviceId,
    is_shed: false,
    shed_since: null,
    shed_reason: null,
    updated_at: now,
  })
}

export function getShedLoads(): LoadState[] {
  const database = getDb()
  const stmt = database.prepare(`SELECT * FROM load_state WHERE is_shed = 1`)
  const rows = stmt.all() as any[]
  return rows.map(row => ({
    device_id: row.device_id,
    is_shed: true,
    shed_since: row.shed_since,
    shed_reason: row.shed_reason,
    updated_at: row.updated_at,
  }))
}

export function getLoadShedDuration(deviceId: string): number | null {
  const state = getLoadState(deviceId)
  if (!state || !state.is_shed || !state.shed_since) return null
  const shedTime = new Date(state.shed_since).getTime()
  const now = Date.now()
  return Math.floor((now - shedTime) / 1000 / 60) // minutes
}

export function clearLoadState(deviceId: string): boolean {
  const database = getDb()
  const stmt = database.prepare(`DELETE FROM load_state WHERE device_id = ?`)
  const result = stmt.run(deviceId)
  return result.changes > 0
}

export function clearAllLoadStates(): number {
  const database = getDb()
  const stmt = database.prepare(`DELETE FROM load_state`)
  const result = stmt.run()
  return result.changes
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP & MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════

export function cleanupOldData(daysToKeep: number = 90): {
  deletedDecisions: number
  deletedStats: number
  deletedAlerts: number
  deletedLoadActions: number
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
  const deleteLoadActions = database.prepare(`
    DELETE FROM load_actions WHERE timestamp < ?
  `)

  const cutoffDateStr = cutoff.split('T')[0]

  return {
    deletedDecisions: deleteDecisions.run(cutoff).changes,
    deletedStats: deleteStats.run(cutoffDateStr).changes,
    deletedAlerts: deleteAlerts.run(cutoff).changes,
    deletedLoadActions: deleteLoadActions.run(cutoff).changes,
  }
}

export function getDatabaseStats(): {
  decisions: number
  hourlyStats: number
  alerts: number
  activeAlerts: number
  loadActions: number
  shedLoads: number
  sizeBytes: number
} {
  const database = getDb()
  
  const decisionsCount = (database.prepare(`SELECT COUNT(*) as c FROM decisions`).get() as any).c
  const statsCount = (database.prepare(`SELECT COUNT(*) as c FROM hourly_stats`).get() as any).c
  const alertsCount = (database.prepare(`SELECT COUNT(*) as c FROM alerts`).get() as any).c
  const activeAlertsCount = (database.prepare(`SELECT COUNT(*) as c FROM alerts WHERE acknowledged = 0`).get() as any).c
  const loadActionsCount = (database.prepare(`SELECT COUNT(*) as c FROM load_actions`).get() as any).c
  const shedLoadsCount = (database.prepare(`SELECT COUNT(*) as c FROM load_state WHERE is_shed = 1`).get() as any).c

  const dbPath = getDbPath()
  const stats = fs.statSync(dbPath)

  return {
    decisions: decisionsCount,
    hourlyStats: statsCount,
    alerts: alertsCount,
    activeAlerts: activeAlertsCount,
    loadActions: loadActionsCount,
    shedLoads: shedLoadsCount,
    sizeBytes: stats.size,
  }
}

/**
 * Storage Interface
 * Simple key-value interface for metrics and state
 */
export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

// In-memory cache for simple key-value storage
const memoryStore: Map<string, unknown> = new Map()

const storage: Storage = {
  async get(key: string): Promise<unknown> {
    // For decision history, return from database
    if (key === 'decisionHistory') {
      return getRecentDecisions(1000).map(d => ({
        timestamp: new Date(d.timestamp).getTime(),
        action: d.action,
        reason: d.reason,
      }))
    }
    
    // For savings stats, return from config
    if (key === 'savingsStats') {
      const value = getConfigValue('savingsStats')
      return value ? JSON.parse(value) : null
    }
    
    return memoryStore.get(key)
  },
  
  async set(key: string, value: unknown): Promise<void> {
    if (key === 'savingsStats') {
      setConfigValue('savingsStats', JSON.stringify(value))
      return
    }
    memoryStore.set(key, value)
  },
}

/**
 * Get the storage singleton
 */
export function getStorage(): Storage {
  return storage
}

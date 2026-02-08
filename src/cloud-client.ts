/**
 * Cloud Client for VoltAssistant Addon
 * Handles WebSocket connection to VoltAssistant Cloud for reporting
 * metrics, receiving config updates, and syncing offline data.
 */

import WebSocket from 'ws';
import { getDb } from './storage';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface CloudConfig {
  enabled: boolean;
  cloudUrl: string;
  apiKey: string;
  reportInterval: number; // seconds between status reports
  heartbeatInterval: number; // seconds between heartbeats
  reconnectDelay: number; // seconds before reconnect attempt
  maxReconnectDelay: number; // max seconds for exponential backoff
  offlineQueueMax: number; // max items in offline queue
}

export interface DecisionReport {
  timestamp: string;
  soc: number;
  price: number;
  solar_watts: number;
  action: string;
  reason: string;
  executed?: boolean;
}

export interface StatusReport {
  soc: number;
  solar: number;
  grid: number;
  load: number;
  battery_state?: string;
}

export interface CloudClientState {
  connected: boolean;
  lastConnected: string | null;
  lastDisconnected: string | null;
  reconnectAttempts: number;
  offlineQueueSize: number;
  lastError: string | null;
}

type IncomingMessage = {
  type: 'config' | 'command' | 'ack' | 'error' | 'welcome';
  data?: any;
  error?: string;
};

type OutgoingMessage = {
  type: 'decision' | 'status' | 'heartbeat' | 'register' | 'hourly_stat';
  data?: any;
};

// ═══════════════════════════════════════════════════════════════════════════
// DEFAULT CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: CloudConfig = {
  enabled: false,
  cloudUrl: 'wss://voltassistant.io/ws',
  apiKey: '',
  reportInterval: 300, // 5 minutes
  heartbeatInterval: 30,
  reconnectDelay: 5,
  maxReconnectDelay: 300, // 5 minutes max
  offlineQueueMax: 1000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CLOUD CLIENT CLASS
// ═══════════════════════════════════════════════════════════════════════════

class CloudClient {
  private config: CloudConfig;
  private ws: WebSocket | null = null;
  private state: CloudClientState = {
    connected: false,
    lastConnected: null,
    lastDisconnected: null,
    reconnectAttempts: 0,
    offlineQueueSize: 0,
    lastError: null,
  };

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private installationId: string | null = null;

  // Callbacks for config/command handling
  private onConfigUpdate: ((config: any) => void) | null = null;
  private onCommand: ((action: string) => void) | null = null;

  constructor() {
    this.config = { ...DEFAULT_CONFIG };
    this.loadConfig();
    this.initOfflineQueue();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONFIG MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  private loadConfig(): void {
    try {
      const db = getDb();
      const row = db.prepare(`SELECT value FROM config WHERE key = 'cloud_config'`).get() as any;
      if (row?.value) {
        const saved = JSON.parse(row.value);
        this.config = { ...DEFAULT_CONFIG, ...saved };
      }
    } catch (error) {
      console.error('Error loading cloud config:', error);
    }
  }

  private saveConfig(): void {
    try {
      const db = getDb();
      db.prepare(`INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)`)
        .run('cloud_config', JSON.stringify(this.config), new Date().toISOString());
    } catch (error) {
      console.error('Error saving cloud config:', error);
    }
  }

  public getConfig(): CloudConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<CloudConfig>): CloudConfig {
    this.config = { ...this.config, ...updates };
    this.saveConfig();

    // Reconnect if URL or API key changed
    if (updates.cloudUrl || updates.apiKey) {
      this.reconnect();
    }

    return this.config;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OFFLINE QUEUE
  // ─────────────────────────────────────────────────────────────────────────

  private initOfflineQueue(): void {
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS cloud_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.updateQueueSize();
    } catch (error) {
      console.error('Error initializing offline queue:', error);
    }
  }

  private updateQueueSize(): void {
    try {
      const db = getDb();
      const row = db.prepare(`SELECT COUNT(*) as c FROM cloud_queue`).get() as any;
      this.state.offlineQueueSize = row?.c || 0;
    } catch (error) {
      // Ignore
    }
  }

  private queueMessage(message: OutgoingMessage): void {
    try {
      const db = getDb();
      
      // Check queue size
      if (this.state.offlineQueueSize >= this.config.offlineQueueMax) {
        // Remove oldest entries
        db.prepare(`
          DELETE FROM cloud_queue WHERE id IN (
            SELECT id FROM cloud_queue ORDER BY id ASC LIMIT 100
          )
        `).run();
      }

      db.prepare(`INSERT INTO cloud_queue (type, data) VALUES (?, ?)`)
        .run(message.type, JSON.stringify(message.data));
      
      this.updateQueueSize();
      console.log(`📦 Queued ${message.type} for offline sync (queue: ${this.state.offlineQueueSize})`);
    } catch (error) {
      console.error('Error queueing message:', error);
    }
  }

  private async flushQueue(): Promise<void> {
    if (!this.state.connected || this.state.offlineQueueSize === 0) return;

    try {
      const db = getDb();
      const rows = db.prepare(`SELECT id, type, data FROM cloud_queue ORDER BY id ASC LIMIT 50`).all() as any[];

      for (const row of rows) {
        const message: OutgoingMessage = {
          type: row.type,
          data: JSON.parse(row.data),
        };

        if (this.send(message)) {
          db.prepare(`DELETE FROM cloud_queue WHERE id = ?`).run(row.id);
        } else {
          break; // Stop if send fails
        }
      }

      this.updateQueueSize();

      if (this.state.offlineQueueSize > 0) {
        console.log(`📤 Flushed queue, ${this.state.offlineQueueSize} items remaining`);
      }
    } catch (error) {
      console.error('Error flushing queue:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  public connect(): boolean {
    if (!this.config.enabled || !this.config.apiKey) {
      console.log('☁️ Cloud client disabled or no API key');
      return false;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('☁️ Already connected');
      return true;
    }

    this.clearTimers();

    const url = `${this.config.cloudUrl}?apiKey=${this.config.apiKey}`;
    console.log(`☁️ Connecting to cloud: ${this.config.cloudUrl}`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log('✅ Cloud connected');
        this.state.connected = true;
        this.state.lastConnected = new Date().toISOString();
        this.state.reconnectAttempts = 0;
        this.state.lastError = null;

        // Send registration
        this.send({ type: 'register', data: { version: '2.1.0' } });

        // Start heartbeat
        this.startHeartbeat();

        // Start status reporting
        this.startStatusReporting();

        // Flush offline queue
        this.flushQueue();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        console.log(`❌ Cloud disconnected (code: ${code})`);
        this.state.connected = false;
        this.state.lastDisconnected = new Date().toISOString();
        this.clearTimers();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('☁️ WebSocket error:', error.message);
        this.state.lastError = error.message;
      });

      return true;
    } catch (error) {
      console.error('☁️ Connection error:', error);
      this.state.lastError = (error as Error).message;
      this.scheduleReconnect();
      return false;
    }
  }

  public disconnect(): void {
    this.config.enabled = false;
    this.saveConfig();
    this.clearTimers();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.state.connected = false;
    console.log('☁️ Cloud client disconnected');
  }

  private reconnect(): void {
    if (this.ws) {
      this.ws.close(1000, 'Reconnecting');
      this.ws = null;
    }
    this.connect();
  }

  private scheduleReconnect(): void {
    if (!this.config.enabled) return;

    this.state.reconnectAttempts++;
    
    // Exponential backoff
    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(2, this.state.reconnectAttempts - 1),
      this.config.maxReconnectDelay
    );

    console.log(`☁️ Reconnecting in ${delay}s (attempt ${this.state.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay * 1000);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MESSAGING
  // ─────────────────────────────────────────────────────────────────────────

  private send(message: OutgoingMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.error('Error sending message:', error);
      return false;
    }
  }

  private handleMessage(data: string): void {
    try {
      const message: IncomingMessage = JSON.parse(data);

      switch (message.type) {
        case 'welcome':
          this.installationId = message.data?.installation_id;
          console.log(`☁️ Welcome from cloud (installation: ${this.installationId})`);
          break;

        case 'config':
          console.log('☁️ Received config update from cloud');
          if (this.onConfigUpdate && message.data) {
            this.onConfigUpdate(message.data);
          }
          break;

        case 'command':
          console.log(`☁️ Received command: ${message.data?.action}`);
          if (this.onCommand && message.data?.action) {
            this.onCommand(message.data.action);
          }
          break;

        case 'ack':
          // Acknowledgement received
          break;

        case 'error':
          console.error(`☁️ Error from cloud: ${message.error}`);
          this.state.lastError = message.error || 'Unknown error';
          break;
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HEARTBEAT & STATUS
  // ─────────────────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, this.config.heartbeatInterval * 1000);
  }

  private startStatusReporting(): void {
    // Status reporting will be triggered externally via reportStatus()
    // This is just a placeholder for any interval-based reporting
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC REPORTING API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Report a scheduler decision to the cloud
   */
  public reportDecision(decision: DecisionReport): void {
    if (!this.config.enabled) return;

    const message: OutgoingMessage = {
      type: 'decision',
      data: decision,
    };

    if (this.state.connected) {
      if (!this.send(message)) {
        this.queueMessage(message);
      }
    } else {
      this.queueMessage(message);
    }
  }

  /**
   * Report current system status to the cloud
   */
  public reportStatus(status: StatusReport): void {
    if (!this.config.enabled) return;

    const message: OutgoingMessage = {
      type: 'status',
      data: status,
    };

    if (this.state.connected) {
      this.send(message); // Don't queue status updates
    }
  }

  /**
   * Report hourly statistics to the cloud
   */
  public reportHourlyStat(stat: {
    date: string;
    hour: number;
    soc: number;
    price: number;
    solar_kwh: number;
    consumption_kwh: number;
    grid_import_kwh: number;
    grid_export_kwh: number;
  }): void {
    if (!this.config.enabled) return;

    const message: OutgoingMessage = {
      type: 'hourly_stat',
      data: stat,
    };

    if (this.state.connected) {
      if (!this.send(message)) {
        this.queueMessage(message);
      }
    } else {
      this.queueMessage(message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CALLBACK REGISTRATION
  // ─────────────────────────────────────────────────────────────────────────

  public setOnConfigUpdate(callback: (config: any) => void): void {
    this.onConfigUpdate = callback;
  }

  public setOnCommand(callback: (action: string) => void): void {
    this.onCommand = callback;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE ACCESS
  // ─────────────────────────────────────────────────────────────────────────

  public getState(): CloudClientState {
    return { ...this.state };
  }

  public isConnected(): boolean {
    return this.state.connected;
  }

  public getInstallationId(): string | null {
    return this.installationId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LINKING
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Link addon to cloud account using API key
   */
  public link(apiKey: string, cloudUrl?: string): boolean {
    this.config.apiKey = apiKey;
    this.config.enabled = true;
    
    if (cloudUrl) {
      this.config.cloudUrl = cloudUrl;
    }
    
    this.saveConfig();
    
    // Try to connect
    return this.connect();
  }

  /**
   * Unlink addon from cloud
   */
  public unlink(): void {
    this.config.apiKey = '';
    this.config.enabled = false;
    this.saveConfig();
    this.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

let instance: CloudClient | null = null;

export function getCloudClient(): CloudClient {
  if (!instance) {
    instance = new CloudClient();
  }
  return instance;
}

export function initCloudClient(): CloudClient {
  const client = getCloudClient();
  if (client.getConfig().enabled && client.getConfig().apiKey) {
    client.connect();
  }
  return client;
}

// Export types and default config
export { CloudClient, DEFAULT_CONFIG as CLOUD_DEFAULT_CONFIG };

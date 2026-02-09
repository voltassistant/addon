/**
 * Backup & Restore System for VoltAssistant
 * Manages configuration backups, scheduled backups, and restore operations
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getConfig, VoltAssistantConfig, saveConfig } from './config';
import { getStorage } from './storage';

export interface BackupMetadata {
  id: string;
  timestamp: number;
  version: string;
  description?: string;
  type: 'manual' | 'scheduled' | 'pre-update';
  size: number;
  checksum: string;
}

export interface BackupData {
  metadata: BackupMetadata;
  config: VoltAssistantConfig;
  schedules?: object[];
  history?: object;
  customSettings?: Record<string, unknown>;
}

export interface RestoreResult {
  success: boolean;
  backupId: string;
  restoredAt: number;
  errors: string[];
  warnings: string[];
}

const BACKUP_DIR = '/config/voltassistant/backups';
const MAX_BACKUPS = 10;
const ADDON_VERSION = '2.1.0';

class BackupManager {
  private backupDir: string;

  constructor() {
    this.backupDir = BACKUP_DIR;
  }

  async initialize(): Promise<void> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      console.log(`[Backup] Initialized backup directory: ${this.backupDir}`);
    } catch (error) {
      console.error('[Backup] Failed to initialize:', error);
    }
  }

  /**
   * Create a new backup
   */
  async createBackup(options?: {
    description?: string;
    type?: BackupMetadata['type'];
    includeHistory?: boolean;
  }): Promise<BackupMetadata> {
    const config = getConfig();
    const storage = getStorage();

    const timestamp = Date.now();
    const id = `backup-${timestamp}`;

    // Gather data to backup
    const backupData: BackupData = {
      metadata: {
        id,
        timestamp,
        version: ADDON_VERSION,
        description: options?.description,
        type: options?.type || 'manual',
        size: 0,
        checksum: '',
      },
      config: this.sanitizeConfig(config),
    };

    // Include schedules
    try {
      const schedules = await storage.get('schedules');
      if (schedules) {
        backupData.schedules = schedules;
      }
    } catch (e) {
      console.warn('[Backup] Could not backup schedules');
    }

    // Include history if requested (can be large)
    if (options?.includeHistory) {
      try {
        const history = await storage.get('decisionHistory');
        if (history) {
          backupData.history = history;
        }
      } catch (e) {
        console.warn('[Backup] Could not backup history');
      }
    }

    // Include custom settings
    try {
      const customSettings = await storage.get('customSettings');
      if (customSettings) {
        backupData.customSettings = customSettings;
      }
    } catch (e) {
      console.warn('[Backup] Could not backup custom settings');
    }

    // Serialize and calculate size/checksum
    const jsonData = JSON.stringify(backupData, null, 2);
    backupData.metadata.size = Buffer.byteLength(jsonData, 'utf8');
    backupData.metadata.checksum = this.calculateChecksum(jsonData);

    // Save backup file
    const backupPath = path.join(this.backupDir, `${id}.json`);
    await fs.writeFile(backupPath, jsonData, 'utf8');

    console.log(`[Backup] Created backup: ${id} (${this.formatSize(backupData.metadata.size)})`);

    // Cleanup old backups
    await this.cleanupOldBackups();

    return backupData.metadata;
  }

  /**
   * List all available backups
   */
  async listBackups(): Promise<BackupMetadata[]> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backups: BackupMetadata[] = [];

      for (const file of files) {
        if (!file.endsWith('.json') || !file.startsWith('backup-')) continue;

        try {
          const filePath = path.join(this.backupDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const data: BackupData = JSON.parse(content);
          backups.push(data.metadata);
        } catch (e) {
          console.warn(`[Backup] Could not read backup ${file}:`, e);
        }
      }

      // Sort by timestamp, newest first
      return backups.sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      console.error('[Backup] Failed to list backups:', error);
      return [];
    }
  }

  /**
   * Get a specific backup by ID
   */
  async getBackup(id: string): Promise<BackupData | null> {
    try {
      const filePath = path.join(this.backupDir, `${id}.json`);
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[Backup] Failed to get backup ${id}:`, error);
      return null;
    }
  }

  /**
   * Restore from a backup
   */
  async restoreBackup(id: string, options?: {
    restoreConfig?: boolean;
    restoreSchedules?: boolean;
    restoreHistory?: boolean;
    restoreCustomSettings?: boolean;
    dryRun?: boolean;
  }): Promise<RestoreResult> {
    const result: RestoreResult = {
      success: false,
      backupId: id,
      restoredAt: Date.now(),
      errors: [],
      warnings: [],
    };

    // Load backup
    const backup = await this.getBackup(id);
    if (!backup) {
      result.errors.push(`Backup not found: ${id}`);
      return result;
    }

    // Verify checksum
    const jsonData = JSON.stringify(backup, null, 2);
    const currentChecksum = this.calculateChecksum(jsonData);
    if (currentChecksum !== backup.metadata.checksum) {
      result.warnings.push('Checksum mismatch - backup may be corrupted');
    }

    // Check version compatibility
    if (backup.metadata.version !== ADDON_VERSION) {
      result.warnings.push(`Version mismatch: backup=${backup.metadata.version}, current=${ADDON_VERSION}`);
    }

    if (options?.dryRun) {
      result.success = true;
      result.warnings.push('Dry run - no changes applied');
      return result;
    }

    // Create pre-restore backup
    try {
      await this.createBackup({
        description: `Pre-restore backup (restoring ${id})`,
        type: 'pre-update',
      });
    } catch (e) {
      result.warnings.push('Could not create pre-restore backup');
    }

    const storage = getStorage();

    // Restore config
    if (options?.restoreConfig !== false && backup.config) {
      try {
        await saveConfig(backup.config);
        console.log('[Backup] Restored configuration');
      } catch (e) {
        result.errors.push(`Failed to restore config: ${e}`);
      }
    }

    // Restore schedules
    if (options?.restoreSchedules !== false && backup.schedules) {
      try {
        await storage.set('schedules', backup.schedules);
        console.log('[Backup] Restored schedules');
      } catch (e) {
        result.errors.push(`Failed to restore schedules: ${e}`);
      }
    }

    // Restore history
    if (options?.restoreHistory && backup.history) {
      try {
        await storage.set('decisionHistory', backup.history);
        console.log('[Backup] Restored history');
      } catch (e) {
        result.errors.push(`Failed to restore history: ${e}`);
      }
    }

    // Restore custom settings
    if (options?.restoreCustomSettings !== false && backup.customSettings) {
      try {
        await storage.set('customSettings', backup.customSettings);
        console.log('[Backup] Restored custom settings');
      } catch (e) {
        result.errors.push(`Failed to restore custom settings: ${e}`);
      }
    }

    result.success = result.errors.length === 0;
    console.log(`[Backup] Restore ${result.success ? 'completed' : 'completed with errors'}`);

    return result;
  }

  /**
   * Delete a backup
   */
  async deleteBackup(id: string): Promise<boolean> {
    try {
      const filePath = path.join(this.backupDir, `${id}.json`);
      await fs.unlink(filePath);
      console.log(`[Backup] Deleted backup: ${id}`);
      return true;
    } catch (error) {
      console.error(`[Backup] Failed to delete backup ${id}:`, error);
      return false;
    }
  }

  /**
   * Export backup to downloadable format
   */
  async exportBackup(id: string): Promise<string | null> {
    const backup = await this.getBackup(id);
    if (!backup) return null;

    // Add export metadata
    const exportData = {
      ...backup,
      exportedAt: Date.now(),
      exportedFrom: 'VoltAssistant Addon',
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Import backup from uploaded data
   */
  async importBackup(jsonData: string): Promise<BackupMetadata | null> {
    try {
      const data: BackupData = JSON.parse(jsonData);

      // Validate structure
      if (!data.metadata || !data.config) {
        throw new Error('Invalid backup format');
      }

      // Generate new ID to avoid conflicts
      const newId = `backup-imported-${Date.now()}`;
      data.metadata.id = newId;
      data.metadata.description = `Imported: ${data.metadata.description || 'No description'}`;

      // Save
      const backupPath = path.join(this.backupDir, `${newId}.json`);
      await fs.writeFile(backupPath, JSON.stringify(data, null, 2), 'utf8');

      console.log(`[Backup] Imported backup: ${newId}`);
      return data.metadata;
    } catch (error) {
      console.error('[Backup] Failed to import backup:', error);
      return null;
    }
  }

  /**
   * Cleanup old backups, keeping MAX_BACKUPS most recent
   */
  private async cleanupOldBackups(): Promise<void> {
    const backups = await this.listBackups();
    
    // Keep manual and pre-update backups longer
    const autoBackups = backups.filter(b => b.type === 'scheduled');
    const importantBackups = backups.filter(b => b.type !== 'scheduled');

    // Only clean up scheduled backups if we have too many
    if (autoBackups.length > MAX_BACKUPS) {
      const toDelete = autoBackups.slice(MAX_BACKUPS);
      for (const backup of toDelete) {
        await this.deleteBackup(backup.id);
      }
      console.log(`[Backup] Cleaned up ${toDelete.length} old backups`);
    }
  }

  /**
   * Sanitize config to remove sensitive data
   */
  private sanitizeConfig(config: VoltAssistantConfig): VoltAssistantConfig {
    const sanitized = { ...config };
    // Remove API keys and other sensitive data
    if (sanitized.cloud_api_key) {
      sanitized.cloud_api_key = '***REDACTED***';
    }
    return sanitized;
  }

  /**
   * Calculate simple checksum for data integrity
   */
  private calculateChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Format file size for display
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /**
   * Get backup statistics
   */
  async getStats(): Promise<{
    totalBackups: number;
    totalSize: number;
    oldestBackup: number | null;
    newestBackup: number | null;
  }> {
    const backups = await this.listBackups();
    const totalSize = backups.reduce((sum, b) => sum + b.size, 0);

    return {
      totalBackups: backups.length,
      totalSize,
      oldestBackup: backups.length > 0 ? backups[backups.length - 1].timestamp : null,
      newestBackup: backups.length > 0 ? backups[0].timestamp : null,
    };
  }
}

// Singleton instance
let instance: BackupManager | null = null;

export function getBackupManager(): BackupManager {
  if (!instance) {
    instance = new BackupManager();
  }
  return instance;
}

// Scheduled backup function (call from cron/scheduler)
export async function runScheduledBackup(): Promise<BackupMetadata | null> {
  try {
    const manager = getBackupManager();
    return await manager.createBackup({
      type: 'scheduled',
      description: 'Scheduled automatic backup',
      includeHistory: false, // Keep scheduled backups small
    });
  } catch (error) {
    console.error('[Backup] Scheduled backup failed:', error);
    return null;
  }
}

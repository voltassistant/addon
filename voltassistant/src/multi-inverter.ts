/**
 * Multi-Inverter Support for VoltAssistant
 * Supports 2+ Deye inverters with individual control and aggregated views
 */

import { EventEmitter } from 'events';
import { getConfig } from './config';
import { HAIntegration } from './ha-integration';

export interface InverterConfig {
  id: string;
  name: string;
  entityPrefix: string;
  priority: number; // Lower = higher priority for load distribution
  maxPower: number; // Maximum power in W
  batteryCapacity: number; // Battery capacity in kWh
  enabled: boolean;
}

export interface InverterState {
  id: string;
  name: string;
  online: boolean;
  batteryLevel: number; // 0-100%
  batteryPower: number; // W, positive = charging
  gridPower: number; // W, positive = importing
  solarPower: number; // W
  loadPower: number; // W
  acOutput: number; // W
  temperature: number; // °C
  status: 'idle' | 'charging' | 'discharging' | 'grid_tie' | 'off_grid' | 'fault';
  lastUpdate: Date;
  errors: string[];
}

export interface AggregatedState {
  totalBatteryPower: number;
  totalSolarPower: number;
  totalLoadPower: number;
  totalGridPower: number;
  averageBatteryLevel: number;
  weightedBatteryLevel: number; // Weighted by capacity
  totalBatteryCapacity: number;
  onlineCount: number;
  totalCount: number;
  inverters: InverterState[];
}

export interface LoadDistributionPlan {
  targetLoad: number;
  distributions: {
    inverterId: string;
    targetPower: number;
    reason: string;
  }[];
  strategy: 'balanced' | 'priority' | 'round_robin' | 'efficiency';
}

const DEFAULT_ENTITIES = {
  batteryLevel: 'sensor.{prefix}_battery_soc',
  batteryPower: 'sensor.{prefix}_battery_power',
  gridPower: 'sensor.{prefix}_grid_power',
  solarPower: 'sensor.{prefix}_pv_power',
  loadPower: 'sensor.{prefix}_load_power',
  acOutput: 'sensor.{prefix}_ac_output_power',
  temperature: 'sensor.{prefix}_temperature',
  status: 'sensor.{prefix}_status',
  workMode: 'select.{prefix}_work_mode',
  chargeCurrent: 'number.{prefix}_max_charge_current',
  dischargeCurrent: 'number.{prefix}_max_discharge_current',
};

export class MultiInverterManager extends EventEmitter {
  private inverters: Map<string, InverterConfig> = new Map();
  private states: Map<string, InverterState> = new Map();
  private ha: HAIntegration;
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 10000; // 10 seconds

  constructor(ha: HAIntegration) {
    super();
    this.ha = ha;
  }

  async initialize(): Promise<void> {
    const config = getConfig();
    const inverterConfigs = config.inverters || [];

    if (inverterConfigs.length === 0) {
      // Default single inverter (backward compatible)
      this.addInverter({
        id: 'primary',
        name: 'Primary Inverter',
        entityPrefix: 'deye',
        priority: 1,
        maxPower: 5000,
        batteryCapacity: 10,
        enabled: true,
      });
    } else {
      for (const inv of inverterConfigs) {
        this.addInverter(inv);
      }
    }

    // Start polling
    await this.pollAllInverters();
    this.pollInterval = setInterval(() => this.pollAllInverters(), this.POLL_INTERVAL_MS);

    console.log(`[MultiInverter] Initialized with ${this.inverters.size} inverter(s)`);
  }

  addInverter(config: InverterConfig): void {
    this.inverters.set(config.id, config);
    this.states.set(config.id, this.createDefaultState(config));
  }

  removeInverter(id: string): boolean {
    return this.inverters.delete(id) && this.states.delete(id);
  }

  getInverterConfig(id: string): InverterConfig | undefined {
    return this.inverters.get(id);
  }

  getAllConfigs(): InverterConfig[] {
    return Array.from(this.inverters.values());
  }

  private createDefaultState(config: InverterConfig): InverterState {
    return {
      id: config.id,
      name: config.name,
      online: false,
      batteryLevel: 0,
      batteryPower: 0,
      gridPower: 0,
      solarPower: 0,
      loadPower: 0,
      acOutput: 0,
      temperature: 0,
      status: 'idle',
      lastUpdate: new Date(0),
      errors: [],
    };
  }

  private getEntityId(prefix: string, entityTemplate: string): string {
    return entityTemplate.replace('{prefix}', prefix);
  }

  async pollInverter(id: string): Promise<InverterState | null> {
    const config = this.inverters.get(id);
    if (!config || !config.enabled) return null;

    const state = this.states.get(id)!;
    const errors: string[] = [];

    try {
      // Fetch all entity states in parallel
      const entities = Object.entries(DEFAULT_ENTITIES).map(([key, template]) => ({
        key,
        entityId: this.getEntityId(config.entityPrefix, template),
      }));

      const results = await Promise.allSettled(
        entities.map(async ({ key, entityId }) => {
          const haState = await this.ha.getEntityState(entityId);
          return { key, value: haState?.state, entityId };
        })
      );

      let hasAnyData = false;

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.value !== undefined) {
          hasAnyData = true;
          const { key, value } = result.value;
          const numValue = parseFloat(value);

          switch (key) {
            case 'batteryLevel':
              state.batteryLevel = isNaN(numValue) ? 0 : Math.max(0, Math.min(100, numValue));
              break;
            case 'batteryPower':
              state.batteryPower = isNaN(numValue) ? 0 : numValue;
              break;
            case 'gridPower':
              state.gridPower = isNaN(numValue) ? 0 : numValue;
              break;
            case 'solarPower':
              state.solarPower = isNaN(numValue) ? 0 : Math.max(0, numValue);
              break;
            case 'loadPower':
              state.loadPower = isNaN(numValue) ? 0 : Math.abs(numValue);
              break;
            case 'acOutput':
              state.acOutput = isNaN(numValue) ? 0 : numValue;
              break;
            case 'temperature':
              state.temperature = isNaN(numValue) ? 0 : numValue;
              break;
            case 'status':
              state.status = this.parseStatus(value);
              break;
          }
        } else if (result.status === 'rejected') {
          errors.push(`Failed to fetch entity: ${result.reason}`);
        }
      }

      state.online = hasAnyData;
      state.lastUpdate = new Date();
      state.errors = errors;

      this.states.set(id, state);
      this.emit('inverterUpdate', id, state);

      return state;
    } catch (error) {
      state.online = false;
      state.errors = [`Poll failed: ${error}`];
      this.states.set(id, state);
      return state;
    }
  }

  private parseStatus(value: string): InverterState['status'] {
    const normalized = value?.toLowerCase() || '';
    if (normalized.includes('charg')) return 'charging';
    if (normalized.includes('discharg')) return 'discharging';
    if (normalized.includes('grid') && normalized.includes('tie')) return 'grid_tie';
    if (normalized.includes('off') && normalized.includes('grid')) return 'off_grid';
    if (normalized.includes('fault') || normalized.includes('error')) return 'fault';
    return 'idle';
  }

  async pollAllInverters(): Promise<void> {
    const promises = Array.from(this.inverters.keys()).map(id => this.pollInverter(id));
    await Promise.allSettled(promises);
    this.emit('aggregatedUpdate', this.getAggregatedState());
  }

  getInverterState(id: string): InverterState | undefined {
    return this.states.get(id);
  }

  getAggregatedState(): AggregatedState {
    const states = Array.from(this.states.values());
    const configs = Array.from(this.inverters.values());

    let totalBatteryPower = 0;
    let totalSolarPower = 0;
    let totalLoadPower = 0;
    let totalGridPower = 0;
    let totalBatteryLevel = 0;
    let weightedBatteryLevel = 0;
    let totalBatteryCapacity = 0;
    let onlineCount = 0;

    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const config = configs.find(c => c.id === state.id);

      if (state.online) {
        onlineCount++;
        totalBatteryPower += state.batteryPower;
        totalSolarPower += state.solarPower;
        totalLoadPower += state.loadPower;
        totalGridPower += state.gridPower;
        totalBatteryLevel += state.batteryLevel;

        if (config) {
          totalBatteryCapacity += config.batteryCapacity;
          weightedBatteryLevel += state.batteryLevel * config.batteryCapacity;
        }
      }
    }

    return {
      totalBatteryPower,
      totalSolarPower,
      totalLoadPower,
      totalGridPower,
      averageBatteryLevel: onlineCount > 0 ? totalBatteryLevel / onlineCount : 0,
      weightedBatteryLevel: totalBatteryCapacity > 0 ? weightedBatteryLevel / totalBatteryCapacity : 0,
      totalBatteryCapacity,
      onlineCount,
      totalCount: states.length,
      inverters: states,
    };
  }

  /**
   * Create a load distribution plan for a target power level
   */
  createLoadDistribution(
    targetLoad: number,
    strategy: 'balanced' | 'priority' | 'round_robin' | 'efficiency' = 'balanced'
  ): LoadDistributionPlan {
    const distributions: LoadDistributionPlan['distributions'] = [];
    const enabledInverters = Array.from(this.inverters.values())
      .filter(inv => inv.enabled)
      .sort((a, b) => a.priority - b.priority);

    const states = new Map(this.states);
    let remainingLoad = targetLoad;

    switch (strategy) {
      case 'priority':
        // Assign load to inverters in priority order
        for (const inv of enabledInverters) {
          const state = states.get(inv.id);
          if (!state?.online) continue;

          const allocatable = Math.min(remainingLoad, inv.maxPower);
          if (allocatable > 0) {
            distributions.push({
              inverterId: inv.id,
              targetPower: allocatable,
              reason: `Priority ${inv.priority}`,
            });
            remainingLoad -= allocatable;
          }

          if (remainingLoad <= 0) break;
        }
        break;

      case 'balanced':
      default:
        // Distribute load evenly across all online inverters
        const onlineInverters = enabledInverters.filter(inv => states.get(inv.id)?.online);
        if (onlineInverters.length === 0) break;

        const totalCapacity = onlineInverters.reduce((sum, inv) => sum + inv.maxPower, 0);
        
        for (const inv of onlineInverters) {
          const share = (inv.maxPower / totalCapacity) * targetLoad;
          const clamped = Math.min(share, inv.maxPower);
          distributions.push({
            inverterId: inv.id,
            targetPower: Math.round(clamped),
            reason: `Balanced ${Math.round((inv.maxPower / totalCapacity) * 100)}%`,
          });
        }
        break;

      case 'efficiency':
        // Prioritize inverters with higher battery levels (more efficient discharge)
        const byEfficiency = enabledInverters
          .filter(inv => states.get(inv.id)?.online)
          .sort((a, b) => {
            const stateA = states.get(a.id);
            const stateB = states.get(b.id);
            return (stateB?.batteryLevel || 0) - (stateA?.batteryLevel || 0);
          });

        for (const inv of byEfficiency) {
          const allocatable = Math.min(remainingLoad, inv.maxPower);
          if (allocatable > 0) {
            const state = states.get(inv.id);
            distributions.push({
              inverterId: inv.id,
              targetPower: allocatable,
              reason: `Battery at ${state?.batteryLevel.toFixed(0)}%`,
            });
            remainingLoad -= allocatable;
          }
          if (remainingLoad <= 0) break;
        }
        break;
    }

    return { targetLoad, distributions, strategy };
  }

  /**
   * Apply a load distribution plan to all inverters
   */
  async applyDistribution(plan: LoadDistributionPlan): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];

    for (const dist of plan.distributions) {
      const config = this.inverters.get(dist.inverterId);
      if (!config) {
        errors.push(`Inverter ${dist.inverterId} not found`);
        continue;
      }

      try {
        // Set the target power via Home Assistant
        const entityId = this.getEntityId(config.entityPrefix, DEFAULT_ENTITIES.dischargeCurrent);
        // Convert power to current (assuming nominal voltage)
        const current = Math.round(dist.targetPower / 48); // 48V nominal

        await this.ha.callService('number', 'set_value', {
          entity_id: entityId,
          value: current,
        });

        console.log(`[MultiInverter] Set ${config.name} to ${dist.targetPower}W (${current}A)`);
      } catch (error) {
        errors.push(`Failed to set ${config.name}: ${error}`);
      }
    }

    return { success: errors.length === 0, errors };
  }

  /**
   * Set work mode for all inverters or a specific one
   */
  async setWorkMode(mode: string, inverterId?: string): Promise<void> {
    const targets = inverterId 
      ? [this.inverters.get(inverterId)].filter(Boolean)
      : Array.from(this.inverters.values()).filter(inv => inv.enabled);

    for (const inv of targets) {
      if (!inv) continue;
      const entityId = this.getEntityId(inv.entityPrefix, DEFAULT_ENTITIES.workMode);
      await this.ha.callService('select', 'select_option', {
        entity_id: entityId,
        option: mode,
      });
      console.log(`[MultiInverter] Set ${inv.name} work mode to: ${mode}`);
    }
  }

  /**
   * Get diagnostic info for all inverters
   */
  getDiagnostics(): object {
    return {
      inverterCount: this.inverters.size,
      configs: Array.from(this.inverters.values()),
      states: Array.from(this.states.values()),
      aggregated: this.getAggregatedState(),
      lastPoll: new Date().toISOString(),
    };
  }

  shutdown(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.removeAllListeners();
  }
}

// Singleton instance
let instance: MultiInverterManager | null = null;

export function getMultiInverterManager(ha: HAIntegration): MultiInverterManager {
  if (!instance) {
    instance = new MultiInverterManager(ha);
  }
  return instance;
}

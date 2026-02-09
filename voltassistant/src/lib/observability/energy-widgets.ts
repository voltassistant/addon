/**
 * Energy Dashboard Widgets
 * 
 * Features:
 * - Lovelace card configurations
 * - Custom widget definitions
 * - Auto-discovery for HA frontend
 * - Energy dashboard integration
 */

// ============================================================================
// Types
// ============================================================================

export interface LovelaceCard {
  type: string;
  title?: string;
  entity?: string;
  entities?: string[];
  [key: string]: unknown;
}

export interface EnergyDashboardConfig {
  title: string;
  icon: string;
  cards: LovelaceCard[];
}

export interface SensorConfig {
  entity_id: string;
  name: string;
  state_class: 'measurement' | 'total' | 'total_increasing';
  device_class?: string;
  unit_of_measurement?: string;
  icon?: string;
}

// ============================================================================
// VoltAssistant Sensors
// ============================================================================

export const SENSORS: SensorConfig[] = [
  // Inverter sensors
  {
    entity_id: 'sensor.voltassistant_battery_soc',
    name: 'Battery State of Charge',
    state_class: 'measurement',
    device_class: 'battery',
    unit_of_measurement: '%',
    icon: 'mdi:battery',
  },
  {
    entity_id: 'sensor.voltassistant_solar_power',
    name: 'Solar Power',
    state_class: 'measurement',
    device_class: 'power',
    unit_of_measurement: 'W',
    icon: 'mdi:solar-power',
  },
  {
    entity_id: 'sensor.voltassistant_grid_power',
    name: 'Grid Power',
    state_class: 'measurement',
    device_class: 'power',
    unit_of_measurement: 'W',
    icon: 'mdi:transmission-tower',
  },
  {
    entity_id: 'sensor.voltassistant_load_power',
    name: 'Load Power',
    state_class: 'measurement',
    device_class: 'power',
    unit_of_measurement: 'W',
    icon: 'mdi:home-lightning-bolt',
  },
  {
    entity_id: 'sensor.voltassistant_battery_power',
    name: 'Battery Power',
    state_class: 'measurement',
    device_class: 'power',
    unit_of_measurement: 'W',
    icon: 'mdi:battery-charging',
  },

  // Energy sensors (for HA Energy Dashboard)
  {
    entity_id: 'sensor.voltassistant_solar_energy',
    name: 'Solar Energy',
    state_class: 'total_increasing',
    device_class: 'energy',
    unit_of_measurement: 'kWh',
    icon: 'mdi:solar-power-variant',
  },
  {
    entity_id: 'sensor.voltassistant_grid_import_energy',
    name: 'Grid Import Energy',
    state_class: 'total_increasing',
    device_class: 'energy',
    unit_of_measurement: 'kWh',
    icon: 'mdi:transmission-tower-import',
  },
  {
    entity_id: 'sensor.voltassistant_grid_export_energy',
    name: 'Grid Export Energy',
    state_class: 'total_increasing',
    device_class: 'energy',
    unit_of_measurement: 'kWh',
    icon: 'mdi:transmission-tower-export',
  },
  {
    entity_id: 'sensor.voltassistant_battery_charge_energy',
    name: 'Battery Charge Energy',
    state_class: 'total_increasing',
    device_class: 'energy',
    unit_of_measurement: 'kWh',
    icon: 'mdi:battery-plus',
  },
  {
    entity_id: 'sensor.voltassistant_battery_discharge_energy',
    name: 'Battery Discharge Energy',
    state_class: 'total_increasing',
    device_class: 'energy',
    unit_of_measurement: 'kWh',
    icon: 'mdi:battery-minus',
  },

  // Financial sensors
  {
    entity_id: 'sensor.voltassistant_daily_savings',
    name: 'Daily Savings',
    state_class: 'total',
    device_class: 'monetary',
    unit_of_measurement: '€',
    icon: 'mdi:piggy-bank',
  },
  {
    entity_id: 'sensor.voltassistant_monthly_savings',
    name: 'Monthly Savings',
    state_class: 'total',
    device_class: 'monetary',
    unit_of_measurement: '€',
    icon: 'mdi:cash-multiple',
  },

  // PVPC sensors
  {
    entity_id: 'sensor.voltassistant_pvpc_current_price',
    name: 'Current Electricity Price',
    state_class: 'measurement',
    device_class: 'monetary',
    unit_of_measurement: '€/kWh',
    icon: 'mdi:currency-eur',
  },
  {
    entity_id: 'sensor.voltassistant_pvpc_average_price',
    name: 'Average Daily Price',
    state_class: 'measurement',
    device_class: 'monetary',
    unit_of_measurement: '€/kWh',
    icon: 'mdi:chart-line',
  },

  // Optimization sensors
  {
    entity_id: 'sensor.voltassistant_current_action',
    name: 'Current Action',
    state_class: 'measurement',
    icon: 'mdi:robot',
  },
  {
    entity_id: 'sensor.voltassistant_self_consumption_ratio',
    name: 'Self Consumption Ratio',
    state_class: 'measurement',
    unit_of_measurement: '%',
    icon: 'mdi:percent',
  },
];

// ============================================================================
// Lovelace Cards
// ============================================================================

export function generateOverviewCard(): LovelaceCard {
  return {
    type: 'custom:voltassistant-overview-card',
    title: 'VoltAssistant Overview',
    entities: {
      battery_soc: 'sensor.voltassistant_battery_soc',
      solar_power: 'sensor.voltassistant_solar_power',
      grid_power: 'sensor.voltassistant_grid_power',
      load_power: 'sensor.voltassistant_load_power',
      current_action: 'sensor.voltassistant_current_action',
      pvpc_price: 'sensor.voltassistant_pvpc_current_price',
    },
  };
}

export function generatePowerFlowCard(): LovelaceCard {
  return {
    type: 'custom:power-flow-card-plus',
    entities: {
      battery: {
        entity: 'sensor.voltassistant_battery_soc',
        state_of_charge: 'sensor.voltassistant_battery_soc',
      },
      grid: {
        entity: 'sensor.voltassistant_grid_power',
        name: 'Grid',
      },
      solar: {
        entity: 'sensor.voltassistant_solar_power',
        name: 'Solar',
      },
      home: {
        entity: 'sensor.voltassistant_load_power',
        name: 'Home',
      },
    },
    clickable_entities: true,
    display_zero_lines: false,
    min_flow_rate: 0.5,
    max_flow_rate: 6,
  };
}

export function generatePVPCPriceCard(): LovelaceCard {
  return {
    type: 'custom:apexcharts-card',
    header: {
      show: true,
      title: 'PVPC Price Today',
      show_states: true,
      colorize_states: true,
    },
    graph_span: '24h',
    span: {
      start: 'day',
    },
    series: [
      {
        entity: 'sensor.voltassistant_pvpc_current_price',
        name: 'Price',
        type: 'column',
        color: 'var(--primary-color)',
        data_generator: `
          const prices = hass.states['sensor.voltassistant_pvpc_prices']?.attributes?.prices || [];
          return prices.map((p, i) => [new Date().setHours(i, 0, 0, 0), p]);
        `,
      },
    ],
    yaxis: [
      {
        min: 0,
        decimals: 3,
        apex_config: {
          tickAmount: 5,
        },
      },
    ],
  };
}

export function generateSavingsCard(): LovelaceCard {
  return {
    type: 'custom:mini-graph-card',
    entities: [
      {
        entity: 'sensor.voltassistant_daily_savings',
        name: 'Today',
        color: '#4CAF50',
      },
    ],
    name: 'Daily Savings',
    hours_to_show: 168, // 1 week
    group_by: 'date',
    aggregate_func: 'max',
    show: {
      graph: 'bar',
      average: true,
      extrema: true,
      legend: false,
    },
    color_thresholds: [
      { value: 0, color: '#f44336' },
      { value: 1, color: '#ff9800' },
      { value: 2, color: '#4CAF50' },
    ],
  };
}

export function generateEnergyFlowCard(): LovelaceCard {
  return {
    type: 'custom:sankey-chart-card',
    sections: [
      {
        entities: [
          { entity_id: 'sensor.voltassistant_solar_energy', name: 'Solar' },
          { entity_id: 'sensor.voltassistant_grid_import_energy', name: 'Grid Import' },
        ],
      },
      {
        entities: [
          { entity_id: 'sensor.voltassistant_load_power', name: 'Consumption' },
          { entity_id: 'sensor.voltassistant_battery_charge_energy', name: 'Battery Charge' },
        ],
      },
      {
        entities: [
          { entity_id: 'sensor.voltassistant_grid_export_energy', name: 'Grid Export' },
        ],
      },
    ],
  };
}

export function generateOptimizationHistoryCard(): LovelaceCard {
  return {
    type: 'history-graph',
    title: 'Optimization History',
    hours_to_show: 24,
    entities: [
      {
        entity: 'sensor.voltassistant_current_action',
        name: 'Action',
      },
      {
        entity: 'sensor.voltassistant_battery_soc',
        name: 'Battery %',
      },
      {
        entity: 'sensor.voltassistant_pvpc_current_price',
        name: 'Price',
      },
    ],
  };
}

export function generateGaugesCard(): LovelaceCard {
  return {
    type: 'horizontal-stack',
    cards: [
      {
        type: 'gauge',
        entity: 'sensor.voltassistant_battery_soc',
        name: 'Battery',
        min: 0,
        max: 100,
        severity: {
          green: 50,
          yellow: 20,
          red: 0,
        },
      },
      {
        type: 'gauge',
        entity: 'sensor.voltassistant_self_consumption_ratio',
        name: 'Self Consumption',
        min: 0,
        max: 100,
        severity: {
          green: 70,
          yellow: 40,
          red: 0,
        },
      },
    ],
  };
}

// ============================================================================
// Full Dashboard Configuration
// ============================================================================

export function generateDashboardConfig(): EnergyDashboardConfig {
  return {
    title: 'VoltAssistant',
    icon: 'mdi:battery-charging-high',
    cards: [
      // Row 1: Overview
      {
        type: 'horizontal-stack',
        cards: [
          generateOverviewCard(),
          generatePowerFlowCard(),
        ],
      },
      // Row 2: Prices and Savings
      {
        type: 'horizontal-stack',
        cards: [
          generatePVPCPriceCard(),
          generateSavingsCard(),
        ],
      },
      // Row 3: Gauges
      generateGaugesCard(),
      // Row 4: Energy Flow
      generateEnergyFlowCard(),
      // Row 5: History
      generateOptimizationHistoryCard(),
    ],
  };
}

// ============================================================================
// Energy Dashboard Configuration
// ============================================================================

export interface HAEnergyConfig {
  energy_sources: Array<{
    type: 'grid' | 'solar' | 'battery';
    entity: string;
    entity_production?: string;
    entity_consumption?: string;
    stat_energy_from?: string;
    stat_energy_to?: string;
  }>;
  device_consumption: Array<{
    stat_consumption: string;
    name?: string;
  }>;
}

export function generateEnergyDashboardConfig(): HAEnergyConfig {
  return {
    energy_sources: [
      // Grid
      {
        type: 'grid',
        entity: 'sensor.voltassistant_grid_power',
        stat_energy_from: 'sensor.voltassistant_grid_import_energy',
        stat_energy_to: 'sensor.voltassistant_grid_export_energy',
      },
      // Solar
      {
        type: 'solar',
        entity: 'sensor.voltassistant_solar_energy',
        stat_energy_from: 'sensor.voltassistant_solar_energy',
      },
      // Battery
      {
        type: 'battery',
        entity: 'sensor.voltassistant_battery_power',
        stat_energy_from: 'sensor.voltassistant_battery_discharge_energy',
        stat_energy_to: 'sensor.voltassistant_battery_charge_energy',
      },
    ],
    device_consumption: [],
  };
}

// ============================================================================
// Custom Card Registration (for HACS)
// ============================================================================

export const CUSTOM_CARDS = [
  {
    type: 'voltassistant-overview-card',
    name: 'VoltAssistant Overview Card',
    description: 'A card showing real-time VoltAssistant status',
    preview: false,
    documentationURL: 'https://github.com/voltassistant/addon',
  },
];

export function registerCustomCards(): void {
  if (typeof window !== 'undefined') {
    (window as any).customCards = (window as any).customCards || [];
    for (const card of CUSTOM_CARDS) {
      (window as any).customCards.push(card);
    }
  }
}

// ============================================================================
// Export
// ============================================================================

export default {
  SENSORS,
  generateOverviewCard,
  generatePowerFlowCard,
  generatePVPCPriceCard,
  generateSavingsCard,
  generateEnergyFlowCard,
  generateOptimizationHistoryCard,
  generateGaugesCard,
  generateDashboardConfig,
  generateEnergyDashboardConfig,
  registerCustomCards,
};
